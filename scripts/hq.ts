#!/usr/bin/env bun
/**
 * hq — Unified Agent-HQ CLI
 *
 * Manages HQ agent, Discord relay, background daemon, and provides
 * an interactive chat interface. Single installable entry point.
 *
 * Install: hq install-cli   (symlinks to ~/.local/bin/hq)
 * Usage:   hq [command] [target] [options]
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync, spawnSync } from "child_process";

// ─── Paths ────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const AGENT_DIR = path.join(REPO_ROOT, "apps/discord-relay");  // kept for relay lock
const RELAY_DIR = path.join(REPO_ROOT, "apps/discord-relay");
const HQ_DIR = path.join(REPO_ROOT, "apps/agent");
const SCRIPTS_DIR = import.meta.dir;
const LAUNCH_AGENTS = path.join(os.homedir(), "Library/LaunchAgents");

const WA_DIR = path.join(REPO_ROOT, "apps/relay-adapter-whatsapp");
const RELAY_SERVER_DIR = path.join(REPO_ROOT, "packages/agent-relay-server");
const WA_AUTH_DIR = path.join(WA_DIR, "auth_info");

const AGENT_DAEMON = "com.agent-hq.agent";
const RELAY_DAEMON = "com.agent-hq.discord-relay";
const WA_DAEMON = "com.agent-hq.whatsapp";
const RELAY_SERVER_DAEMON = "com.agent-hq.relay-server";

const AGENT_LOG = path.join(os.homedir(), "Library/Logs/hq-agent.log");
const AGENT_ERR = path.join(os.homedir(), "Library/Logs/hq-agent.error.log");
const RELAY_LOG = path.join(os.homedir(), "Library/Logs/discord-relay.log");
const RELAY_ERR = path.join(os.homedir(), "Library/Logs/discord-relay.error.log");
const WA_LOG = path.join(os.homedir(), "Library/Logs/agent-hq-whatsapp.log");
const WA_ERR = path.join(os.homedir(), "Library/Logs/agent-hq-whatsapp.error.log");
const RELAY_SERVER_LOG = path.join(os.homedir(), "Library/Logs/agent-hq-relay-server.log");
const RELAY_SERVER_ERR = path.join(os.homedir(), "Library/Logs/agent-hq-relay-server.error.log");
const DAEMON_LOG = path.join(os.homedir(), "Library/Logs/hq-daemon.log");
const DAEMON_PID = path.join(os.homedir(), "Library/Logs/hq-daemon.pid");

const RELAY_LOCK = path.join(RELAY_DIR, ".discord-relay/bot.lock");

// ─── ANSI colours ─────────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

// Strip ANSI codes for length calculation
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ─── Shell helpers ────────────────────────────────────────────────────────────

function sh(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch { return ""; }
}

function isAlive(pid: string): boolean {
  if (!/^\d+$/.test(pid)) return false;
  return sh(`kill -0 ${pid} 2>/dev/null; echo $?`) === "0";
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Output helpers ───────────────────────────────────────────────────────────

const ok = (msg: string) => console.log(`${c.green}✅${c.reset}  ${msg}`);
const fail = (msg: string) => console.log(`${c.red}❌${c.reset}  ${msg}`);
const warn = (msg: string) => console.log(`${c.yellow}⚠️ ${c.reset}  ${msg}`);
const info = (msg: string) => console.log(`${c.cyan}ℹ️ ${c.reset}  ${msg}`);
const dim = (msg: string) => console.log(`${c.gray}${msg}${c.reset}`);

function section(title: string) {
  console.log(`\n${c.bold}── ${title} ──${c.reset}`);
}

// ─── Daemon / process helpers ─────────────────────────────────────────────────

function daemonPid(daemon: string): string | null {
  const line = sh(`launchctl list 2>/dev/null | grep "${daemon}"`);
  if (!line) return null;
  const pid = line.trim().split(/\s+/)[0];
  return pid && pid !== "-" && isAlive(pid) ? pid : null;
}

function agentPid(): string | null { return daemonPid(AGENT_DAEMON); }

function relayPid(): string | null {
  // Try lock file first (most reliable)
  if (fs.existsSync(RELAY_LOCK)) {
    const pid = fs.readFileSync(RELAY_LOCK, "utf-8").trim();
    if (pid && isAlive(pid)) return pid;
  }
  return daemonPid(RELAY_DAEMON);
}

function whatsappPid(): string | null { return daemonPid(WA_DAEMON); }
function relayServerPid(): string | null { return daemonPid(RELAY_SERVER_DAEMON); }

function uptime(pid: string): string {
  return sh(`ps -o etime= -p ${pid} 2>/dev/null`).trim() || "?";
}

type ServiceTarget = "agent" | "relay" | "whatsapp" | "relay-server";

function resolveTargets(target?: string): ServiceTarget[] {
  if (!target || target === "all") return ["agent", "relay", "relay-server", "whatsapp"];
  if (target === "agent") return ["agent"];
  if (target === "relay") return ["relay"];
  if (target === "whatsapp" || target === "wa") return ["whatsapp"];
  if (target === "relay-server") return ["relay-server"];
  warn(`Unknown target "${target}" — expected agent, relay, whatsapp, relay-server, or all`);
  return [];
}

/** Map a service target to its daemon label, PID, labels, and log paths. */
function serviceInfo(t: ServiceTarget) {
  switch (t) {
    case "agent":
      return { daemon: AGENT_DAEMON, pid: agentPid, label: "HQ Agent", dir: HQ_DIR, log: AGENT_LOG, err: AGENT_ERR };
    case "relay":
      return { daemon: RELAY_DAEMON, pid: relayPid, label: "Discord Relay", dir: RELAY_DIR, log: RELAY_LOG, err: RELAY_ERR };
    case "whatsapp":
      return { daemon: WA_DAEMON, pid: whatsappPid, label: "WhatsApp", dir: WA_DIR, log: WA_LOG, err: WA_ERR };
    case "relay-server":
      return { daemon: RELAY_SERVER_DAEMON, pid: relayServerPid, label: "Relay Server", dir: RELAY_SERVER_DIR, log: RELAY_SERVER_LOG, err: RELAY_SERVER_ERR };
  }
}

/**
 * Find all PIDs matching a pgrep pattern, kill their children first,
 * then kill them. Returns the count of processes killed.
 */
function killProcessTree(pid: string, label: string): number {
  let killed = 0;
  // Find and kill children recursively
  const children = sh(`pgrep -P ${pid} 2>/dev/null`).split("\n").filter(Boolean);
  for (const child of children) {
    killed += killProcessTree(child, `${label} child`);
  }
  // Kill the process itself
  if (isAlive(pid)) {
    sh(`kill -9 ${pid} 2>/dev/null`);
    info(`Killed ${label} (PID ${pid})`);
    killed++;
  }
  return killed;
}

/**
 * Find ALL instances of a service by scanning process table.
 * Returns unique PIDs matching the service's working directory or entry script.
 */
function findAllInstances(target: ServiceTarget): string[] {
  const svc = serviceInfo(target);
  const pids = new Set<string>();

  // Method 1: pgrep by command matching the app directory
  for (const pid of sh(`pgrep -f "${svc.dir}" 2>/dev/null`).split("\n").filter(Boolean)) {
    // Exclude our own hq.ts process
    const cmdline = sh(`ps -o command= -p ${pid} 2>/dev/null`);
    if (cmdline && !cmdline.includes("hq.ts") && !cmdline.includes("scripts/hq")) {
      pids.add(pid);
    }
  }

  // Method 2: lsof to find processes with cwd in the app directory
  for (const line of sh(`lsof +D "${svc.dir}" -t 2>/dev/null`).split("\n").filter(Boolean)) {
    const cmdline = sh(`ps -o command= -p ${line} 2>/dev/null`);
    if (cmdline && !cmdline.includes("hq.ts") && !cmdline.includes("scripts/hq")) {
      pids.add(line);
    }
  }

  return [...pids];
}

/**
 * Aggressively stop all instances of a target service.
 * Kills daemon PID + children, then sweeps for any remaining instances.
 */
async function killAllInstances(target: ServiceTarget): Promise<number> {
  const svc = serviceInfo(target);
  let killed = 0;

  // 1. Stop via launchctl
  sh(`launchctl stop "${svc.daemon}" 2>/dev/null`);

  // 2. Kill the primary daemon PID and its entire process tree
  const primaryPid = svc.pid();
  if (primaryPid) {
    killed += killProcessTree(primaryPid, `${svc.label} (primary)`);
  }

  // 3. Sweep for any remaining instances (duplicates, orphans, zombies)
  await sleep(300);
  const remaining = findAllInstances(target);
  for (const pid of remaining) {
    if (isAlive(pid)) {
      killed += killProcessTree(pid, `${svc.label} (stale instance)`);
    }
  }

  // 4. Final pkill sweep as a safety net
  // Use the entry script pattern (index.ts or src/index.ts)
  const entryPattern = target === "relay-server" ? `${svc.dir}/src/index.ts` : `${svc.dir}/index.ts`;
  sh(`pkill -9 -f "bun.*${entryPattern}" 2>/dev/null`);
  sh(`pkill -9 -f "node.*${entryPattern}" 2>/dev/null`);

  return killed;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

// hq  |  hq chat
async function cmdChat(): Promise<void> {
  const chatScript = path.join(SCRIPTS_DIR, "agent-hq-chat.ts");
  spawnSync(process.execPath, [chatScript], { stdio: "inherit", env: process.env });
}

// hq status  |  hq s
async function cmdStatus(onlyTarget?: string): Promise<void> {
  console.log(`\n${c.bold}━━━ Agent HQ Status ━━━${c.reset}\n`);

  const targets = onlyTarget ? resolveTargets(onlyTarget) : resolveTargets("all");
  for (const t of targets) {
    const svc = serviceInfo(t);
    const pid = svc.pid();
    const padded = svc.label.padEnd(14);
    pid
      ? ok(`${padded} running  ${c.gray}(PID: ${pid}, uptime: ${uptime(pid)})${c.reset}`)
      : fail(`${padded} not running`);
  }

  console.log();
}

// hq start [agent|relay|whatsapp|relay-server|all]
async function cmdStart(target?: string): Promise<void> {
  const targets = resolveTargets(target);

  // If starting whatsapp, ensure relay-server is started first
  if (targets.includes("whatsapp") && !targets.includes("relay-server")) {
    const rsPid = relayServerPid();
    if (!rsPid) {
      info("Starting relay server (required by WhatsApp adapter)...");
      sh(`launchctl start "${RELAY_SERVER_DAEMON}" 2>/dev/null`);
      await sleep(2500);
      const rsNew = relayServerPid();
      rsNew
        ? ok(`Relay Server started (PID: ${rsNew})`)
        : warn("Relay Server may not have started — WhatsApp may fail to connect");
    }
  }

  for (const t of targets) {
    const svc = serviceInfo(t);
    const pid = svc.pid();

    if (pid) { warn(`${svc.label} already running (PID: ${pid})`); continue; }

    sh(`launchctl start "${svc.daemon}" 2>/dev/null`);
    await sleep(2500);

    const newPid = svc.pid();
    newPid
      ? ok(`${svc.label} started (PID: ${newPid})`)
      : fail(`${svc.label} failed to start — run: hq errors ${t}`);
  }
}

// hq stop [agent|relay|whatsapp|relay-server|all]
async function cmdStop(target?: string): Promise<void> {
  for (const t of resolveTargets(target)) {
    const svc = serviceInfo(t);

    const killed = await killAllInstances(t);
    await sleep(500);

    // Verify nothing survived
    const survivors = findAllInstances(t).filter(p => isAlive(p));
    if (survivors.length > 0) {
      warn(`${svc.label}: ${survivors.length} process(es) still alive after stop, force-killing...`);
      for (const pid of survivors) {
        sh(`kill -9 ${pid} 2>/dev/null`);
      }
      await sleep(300);
    }

    killed > 0
      ? console.log(`⏹️   ${svc.label} stopped (killed ${killed} process${killed > 1 ? "es" : ""})`)
      : console.log(`⏹️   ${svc.label} stopped (was not running)`);
  }
}

// hq restart [agent|relay|whatsapp|relay-server|all]  |  hq r
async function cmdRestart(target?: string): Promise<void> {
  section("Stopping all instances");
  await cmdStop(target);
  await sleep(1000);

  // Clean stale relay lock
  if ((!target || target === "all" || target === "relay") && fs.existsSync(RELAY_LOCK)) {
    const lockPid = fs.readFileSync(RELAY_LOCK, "utf-8").trim();
    if (!isAlive(lockPid)) {
      fs.rmSync(RELAY_LOCK);
      info("Cleaned stale relay lock");
    }
  }

  // Final sanity check — ensure nothing survived
  for (const t of resolveTargets(target)) {
    const svc = serviceInfo(t);
    const zombies = findAllInstances(t).filter(p => isAlive(p));
    if (zombies.length > 0) {
      warn(`${svc.label}: ${zombies.length} zombie(s) found, force-killing before start...`);
      for (const pid of zombies) {
        sh(`kill -9 ${pid} 2>/dev/null`);
      }
      await sleep(500);
    }
  }

  section("Starting fresh");
  await cmdStart(target);

  // Confirm only one instance per target is running
  await sleep(1500);
  for (const t of resolveTargets(target)) {
    const svc = serviceInfo(t);
    const allPids = findAllInstances(t).filter(p => isAlive(p));
    if (allPids.length > 1) {
      warn(`${svc.label}: detected ${allPids.length} instances — killing extras...`);
      const primary = svc.pid();
      for (const pid of allPids) {
        if (pid !== primary) {
          killProcessTree(pid, `${svc.label} (duplicate)`);
        }
      }
    } else if (allPids.length === 1) {
      ok(`${svc.label}: single instance confirmed (PID ${allPids[0]})`);
    }
  }
}

// hq logs [agent|relay|whatsapp|relay-server|all] [N]  |  hq l
async function cmdLogs(target?: string, n = 30): Promise<void> {
  for (const t of resolveTargets(target)) {
    const svc = serviceInfo(t);
    section(`${svc.label} — last ${n} lines`);
    if (fs.existsSync(svc.log)) {
      const lines = fs.readFileSync(svc.log, "utf-8").split("\n").slice(-n).join("\n");
      console.log(lines || "(empty)");
    } else {
      dim("(no log file yet)");
    }
  }
}

// hq errors [agent|relay|whatsapp|relay-server|all] [N]  |  hq e
async function cmdErrors(target?: string, n = 20): Promise<void> {
  for (const t of resolveTargets(target)) {
    const svc = serviceInfo(t);
    section(`${svc.label} errors — last ${n} lines`);
    if (fs.existsSync(svc.err)) {
      const lines = fs.readFileSync(svc.err, "utf-8").split("\n").slice(-n).join("\n");
      console.log(lines || "(no errors)");
    } else {
      dim("(no error log yet)");
    }
  }
}

// hq follow [agent|relay|whatsapp|relay-server|all]  |  hq f
async function cmdFollow(target?: string): Promise<void> {
  const targets = resolveTargets(target);
  const files = targets.map(t => serviceInfo(t).log);
  section(`Following ${targets.join(" + ")} logs (Ctrl+C to stop)`);
  spawnSync("tail", ["-f", ...files], { stdio: "inherit" });
}

// hq ps  |  hq p
async function cmdPs(): Promise<void> {
  section("Agent HQ Processes");
  console.log();

  const icons: Record<ServiceTarget, string> = { agent: "🤖", relay: "📡", "relay-server": "🔌", whatsapp: "📱" };
  for (const t of resolveTargets("all")) {
    const svc = serviceInfo(t);
    const pid = svc.pid();
    const padded = svc.label.padEnd(14);
    console.log(pid
      ? `${icons[t]}  ${padded} PID ${pid} (uptime: ${uptime(pid)})`
      : `${icons[t]}  ${padded} not running`);
  }

  console.log();

  for (const [icon, label, pattern] of [
    ["🟣", "Claude Code", "claude.*--resume|claude.*--print|claude.*--output-format"],
    ["🟢", "OpenCode", "opencode run"],
    ["🔵", "Gemini CLI", "gemini.*--output-format|gemini.*--yolo"],
  ] as const) {
    const pids = sh(`pgrep -f "${pattern}" 2>/dev/null`).split("\n").filter(Boolean);
    if (pids.length) {
      console.log(`${icon}  ${label} CLIs:`);
      for (const pid of pids) {
        const cmd = sh(`ps -o command= -p ${pid} 2>/dev/null`).substring(0, 80);
        console.log(`    PID ${pid} (${uptime(pid)}) ${c.gray}${cmd}${c.reset}`);
      }
    } else {
      console.log(`${icon}  ${label} CLIs: none`);
    }
  }

  console.log();
  if (fs.existsSync(RELAY_LOCK)) {
    const lockPid = fs.readFileSync(RELAY_LOCK, "utf-8").trim();
    console.log(isAlive(lockPid)
      ? `🔒  Relay lock: PID ${lockPid} (active)`
      : `⚠️   Relay lock: PID ${lockPid} (STALE — run: hq clean)`);
  } else {
    console.log(`🔓  Relay lock: none`);
  }
  console.log();
}

// hq health  |  hq h
async function cmdHealth(): Promise<void> {
  console.log(`\n${c.bold}━━━ Agent HQ Health Check ━━━${c.reset}`);
  await cmdStatus();

  section("CLI Tools");
  const claudeV = sh("claude --version 2>/dev/null");
  const geminiV = sh("gemini --version 2>/dev/null");
  const ocV = sh("opencode --version 2>/dev/null | head -1");
  const bunV = sh("bun --version 2>/dev/null");

  claudeV ? ok(`Claude CLI: ${claudeV}`) : fail("Claude CLI: not found");
  geminiV ? ok(`Gemini CLI: ${geminiV}`) : warn("Gemini CLI: not found (optional)");
  ocV ? ok(`OpenCode CLI: ${ocV}`) : warn("OpenCode CLI: not found (optional)");
  bunV ? ok(`Bun: ${bunV}`) : fail("Bun: not found");

  section("Daemons");
  for (const t of resolveTargets("all")) {
    const svc = serviceInfo(t);
    const plistPath = path.join(LAUNCH_AGENTS, `${svc.daemon}.plist`);
    const padded = `${svc.label} daemon:`.padEnd(26);
    fs.existsSync(plistPath)
      ? ok(`${padded} installed`)
      : warn(`${padded} not installed  (run: hq install)`);
  }

  section("Recent Logs");
  for (const t of resolveTargets("all")) {
    const svc = serviceInfo(t);
    console.log(`${c.bold}${svc.label}:${c.reset}`);
    dim(fs.existsSync(svc.log)
      ? fs.readFileSync(svc.log, "utf-8").split("\n").slice(-3).join("\n")
      : "(no logs yet)");
  }

  console.log();
}

// hq install [agent|relay|all]
async function cmdInstall(target?: string): Promise<void> {
  for (const t of resolveTargets(target)) {
    const daemon = t === "agent" ? AGENT_DAEMON : RELAY_DAEMON;
    const srcDir = t === "agent" ? HQ_DIR : RELAY_DIR;
    const plistSrc = path.join(srcDir, `${daemon}.plist`);
    const plistDst = path.join(LAUNCH_AGENTS, `${daemon}.plist`);
    const label = t === "agent" ? "HQ Agent" : "Relay";

    if (!fs.existsSync(plistSrc)) {
      fail(`${label} plist not found: ${plistSrc}`);
      continue;
    }
    fs.mkdirSync(LAUNCH_AGENTS, { recursive: true });
    fs.copyFileSync(plistSrc, plistDst);
    sh(`launchctl load "${plistDst}" 2>/dev/null`);
    ok(`${label} daemon installed and started`);
  }
}

// hq uninstall [agent|relay|all]
async function cmdUninstall(target?: string): Promise<void> {
  for (const t of resolveTargets(target)) {
    const daemon = t === "agent" ? AGENT_DAEMON : RELAY_DAEMON;
    const plistDst = path.join(LAUNCH_AGENTS, `${daemon}.plist`);
    const label = t === "agent" ? "HQ Agent" : "Relay";

    sh(`launchctl unload "${plistDst}" 2>/dev/null`);
    if (fs.existsSync(plistDst)) {
      fs.rmSync(plistDst);
      ok(`${label} daemon uninstalled`);
    } else {
      warn(`${label} daemon was not installed`);
    }
  }
}

// hq kill  |  hq k
async function cmdKill(): Promise<void> {
  console.log("☠️   Killing all Agent HQ processes...\n");

  const ap = agentPid();
  const rp = relayPid();
  if (ap) { sh(`kill -9 ${ap} 2>/dev/null`); info(`Killed HQ Agent (PID ${ap})`); }
  if (rp) { sh(`kill -9 ${rp} 2>/dev/null`); info(`Killed Relay    (PID ${rp})`); }

  sh(`pkill -9 -f "claude.*--resume|claude.*--print|claude.*--output-format" 2>/dev/null`);
  sh(`pkill -9 -f "opencode run" 2>/dev/null`);
  sh(`pkill -9 -f "gemini.*--output-format|gemini.*--yolo" 2>/dev/null`);

  if (fs.existsSync(RELAY_LOCK)) {
    fs.rmSync(RELAY_LOCK);
    info("Removed relay lock file");
  }

  await sleep(500);
  ok("Done");
}

// hq clean  |  hq c
async function cmdClean(): Promise<void> {
  section("Cleaning stale state");

  // Relay lock
  if (fs.existsSync(RELAY_LOCK)) {
    const lockPid = fs.readFileSync(RELAY_LOCK, "utf-8").trim();
    if (!isAlive(lockPid)) {
      fs.rmSync(RELAY_LOCK);
      ok(`Removed stale relay lock (PID ${lockPid})`);
    } else {
      info(`Relay lock held by active PID ${lockPid}`);
    }
  } else {
    info("No relay lock file");
  }

  // Orphaned CLI children
  let orphans = 0;
  const rp = relayPid();
  const checkOrphans = (pattern: string, label: string) => {
    for (const pid of sh(`pgrep -f "${pattern}" 2>/dev/null`).split("\n").filter(Boolean)) {
      const ppid = sh(`ps -o ppid= -p ${pid} 2>/dev/null`).trim();
      if (!rp || !ppid.includes(rp)) {
        sh(`kill -9 ${pid} 2>/dev/null`);
        info(`Killed orphaned ${label} (PID ${pid})`);
        orphans++;
      }
    }
  };

  checkOrphans("claude.*--resume|claude.*--output-format", "Claude CLI");
  checkOrphans("opencode run", "OpenCode CLI");
  checkOrphans("gemini.*--output-format|gemini.*--yolo", "Gemini CLI");

  if (orphans === 0) ok("No orphaned CLI processes");
  ok("Clean complete");
}

// hq fg [agent|relay|whatsapp]
async function cmdFg(target = "agent"): Promise<void> {
  if (target === "whatsapp") {
    const waDir = path.join(REPO_ROOT, "apps/relay-adapter-whatsapp");
    console.log("Starting WhatsApp relay in foreground (Ctrl+C to stop)...");
    spawnSync(process.execPath, ["src/index.ts"], { cwd: waDir, stdio: "inherit" });
    return;
  }

  const isAgent = target === "agent";
  const daemon = isAgent ? AGENT_DAEMON : RELAY_DAEMON;
  const dir = isAgent ? HQ_DIR : RELAY_DIR;
  const label = isAgent ? "HQ Agent" : "Relay";
  const pid = isAgent ? agentPid() : relayPid();

  sh(`launchctl stop "${daemon}" 2>/dev/null`);
  if (pid) sh(`kill ${pid} 2>/dev/null`);
  await sleep(1000);

  console.log(`Starting ${label} in foreground (Ctrl+C to stop)...`);
  spawnSync(process.execPath, ["index.ts"], { cwd: dir, stdio: "inherit" });
}

// hq whatsapp — start relay server (if needed) + WhatsApp adapter in foreground
async function cmdWhatsApp(): Promise<void> {
  const { spawn } = await import("child_process");
  const fs = await import("fs");
  const RELAY_PORT = 18900;
  const RELAY_SERVER_DIR = path.join(REPO_ROOT, "packages/agent-relay-server");
  const WA_DIR = path.join(REPO_ROOT, "apps/relay-adapter-whatsapp");
  const VAULT_PATH = process.env.VAULT_PATH || path.join(REPO_ROOT, ".vault");

  // ── Load env vars from .env.local files so relay server gets them ─
  const relayEnv: Record<string, string> = { ...process.env as Record<string, string>, VAULT_PATH };
  // Check for OPENROUTER_API_KEY in common .env.local locations
  for (const envDir of [
    WA_DIR,
    path.join(REPO_ROOT, "apps/agent"),
    REPO_ROOT,
  ]) {
    const envFile = path.join(envDir, ".env.local");
    try {
      if (fs.existsSync(envFile)) {
        const lines = fs.readFileSync(envFile, "utf-8").split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx === -1) continue;
          const key = trimmed.substring(0, eqIdx).trim();
          const val = trimmed.substring(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
          // Only set if not already in env (shell env takes priority)
          if (!relayEnv[key]) {
            relayEnv[key] = val;
          }
        }
      }
    } catch {
      // Non-critical
    }
  }

  // ── Check if relay server is already listening ──────────────────
  let relayAlive = false;
  try {
    const res = await fetch(`http://127.0.0.1:${RELAY_PORT}/health`);
    relayAlive = res.ok;
  } catch {
    // Not reachable
  }

  let relayChild: ReturnType<typeof spawn> | null = null;

  if (relayAlive) {
    ok(`Relay server already running on port ${RELAY_PORT}`);
  } else {
    info(`Starting relay server on port ${RELAY_PORT}...`);
    relayChild = spawn(process.execPath, ["src/index.ts"], {
      cwd: RELAY_SERVER_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      // Disable agent bridge — hq wa doesn't start the HQ agent,
      // so routing to port 5678 would black-hole messages.
      env: { ...relayEnv, AGENT_WS_PORT: "0" },
    });

    // Give it a moment to bind the port
    relayChild.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`${c.gray}[relay-server] ${line}${c.reset}`);
    });
    relayChild.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.error(`${c.red}[relay-server] ${line}${c.reset}`);
    });

    // Wait for the relay server to become ready (up to 10s)
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      try {
        const res = await fetch(`http://127.0.0.1:${RELAY_PORT}/health`);
        if (res.ok) { ready = true; break; }
      } catch { /* not yet */ }
    }

    if (ready) {
      ok("Relay server started");
    } else {
      warn("Relay server may not be ready — proceeding anyway");
    }
  }

  // ── Start WhatsApp adapter (async so relay server logs keep flowing) ─
  console.log();
  info("Starting WhatsApp adapter (Ctrl+C to stop both)...");
  console.log();

  const waChild = spawn(process.execPath, ["src/index.ts"], {
    cwd: WA_DIR,
    stdio: "inherit",
    env: { ...process.env },
  });

  // Handle Ctrl+C — kill both processes
  const cleanup = () => {
    waChild.kill("SIGTERM");
    if (relayChild) relayChild.kill("SIGTERM");
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Wait for the WhatsApp adapter to exit
  const waExitCode = await new Promise<number>((resolve) => {
    waChild.on("exit", (code) => resolve(code ?? 0));
  });

  // ── Cleanup: kill relay server if we started it ─────────────────
  if (relayChild) {
    info("Stopping relay server...");
    relayChild.kill("SIGTERM");
    // Give it a moment to shutdown gracefully
    await sleep(1000);
    if (!relayChild.killed) relayChild.kill("SIGKILL");
    ok("Relay server stopped");
  }

  process.exit(waExitCode);
}

// hq wa reset — clear WhatsApp conversation thread
async function cmdWaReset(): Promise<void> {
  const VAULT_PATH = process.env.VAULT_PATH || path.join(REPO_ROOT, ".vault");
  const threadFile = path.join(VAULT_PATH, "_threads", "wa-self.md");

  if (fs.existsSync(threadFile)) {
    fs.rmSync(threadFile);
    ok("WhatsApp conversation thread cleared");
  } else {
    info("No WhatsApp thread file found (already clean)");
  }

  console.log();
  info("If the adapter is running, send !reset in WhatsApp or restart the service:");
  dim("  hq restart whatsapp");
}

// hq wa reauth — clear WhatsApp credentials and force QR re-scan
async function cmdWaReauth(): Promise<void> {
  // Stop the service first
  const waPid = whatsappPid();
  if (waPid) {
    info("Stopping WhatsApp adapter...");
    await cmdStop("whatsapp");
  }

  // Delete the auth directory
  if (fs.existsSync(WA_AUTH_DIR)) {
    fs.rmSync(WA_AUTH_DIR, { recursive: true });
    ok("WhatsApp auth credentials cleared");
  } else {
    info("No auth credentials found (already clean)");
  }

  console.log();
  ok("Auth cleared. To re-authenticate:");
  dim("  1. Run: hq wa");
  dim("  2. Scan the QR code with WhatsApp");
  dim("  3. Once connected, Ctrl+C and run: hq start whatsapp");
}

// hq install-cli
async function cmdInstallCli(): Promise<void> {
  const hqScript = path.join(SCRIPTS_DIR, "hq.ts");
  const binDir = path.join(os.homedir(), ".local/bin");
  const binPath = path.join(binDir, "hq");

  fs.mkdirSync(binDir, { recursive: true });
  fs.chmodSync(hqScript, 0o755);
  if (fs.existsSync(binPath)) fs.rmSync(binPath);
  fs.symlinkSync(hqScript, binPath);

  ok(`hq CLI installed → ${binPath}`);

  if (!process.env.PATH?.split(":").includes(binDir)) {
    console.log();
    warn(`${binDir} is not in your PATH`);
    info(`Add this to your ~/.zshrc:`);
    console.log(`  ${c.bold}export PATH="$HOME/.local/bin:$PATH"${c.reset}`);
  } else {
    ok(`${binDir} is already in PATH`);
  }
}

// hq coo
async function cmdCoo(subcommand?: string, arg?: string): Promise<void> {
  const VAULT_PATH = process.env.VAULT_PATH ?? path.resolve(REPO_ROOT, ".vault");

  function setCooMode(vaultPath: string, mode: string, cooName?: string) {
    const configPath = path.join(vaultPath, "_system/CONFIG.md");
    if (!fs.existsSync(configPath)) {
      fail("CONFIG.md not found in _system");
      return;
    }
    let content = fs.readFileSync(configPath, "utf-8");
    content = content.replace(
      /\| orchestration_mode\s*\|\s*[a-zA-Z0-9_\-]*\s*\|/,
      `| orchestration_mode | ${mode} |`
    );
    if (cooName !== undefined) {
      content = content.replace(
        /\| active_coo\s*\|\s*[a-zA-Z0-9_\-]*\s*\|/,
        `| active_coo | ${cooName} |`
      );
    }
    fs.writeFileSync(configPath, content, "utf-8");
  }

  const sysOrchestrators = path.join(VAULT_PATH, "_system/orchestrators");
  const extMemories = path.join(VAULT_PATH, "_external");

  if (subcommand === "install" && arg) {
    fs.mkdirSync(sysOrchestrators, { recursive: true });
    const name = path.basename(arg, '.git');
    const targetDir = path.join(sysOrchestrators, name);
    if (fs.existsSync(targetDir)) {
      fail(`COO ${name} is already installed`);
      return;
    }
    console.log(`Installing COO: ${name}...`);
    try {
      spawnSync("git", ["clone", arg, targetDir], { stdio: "inherit" });
      execSync(`bun install`, { cwd: targetDir, stdio: "inherit" });
      const memoryDir = path.join(extMemories, name);
      fs.mkdirSync(memoryDir, { recursive: true });
      ok(`Installed ${name}`);
    } catch (e: any) {
      fail(`Installation failed: ${e.message}`);
    }
  } else if (subcommand === "uninstall" && arg) {
    const targetDir = path.join(sysOrchestrators, arg);
    if (!fs.existsSync(targetDir)) {
      fail(`COO ${arg} not found`);
      return;
    }
    fs.rmSync(targetDir, { recursive: true, force: true });
    ok(`Uninstalled sandbox for ${arg} (memory preserved)`);
  } else if (subcommand === "activate" && arg) {
    setCooMode(VAULT_PATH, "external", arg);
    ok(`Activated COO: ${arg}`);
  } else if (subcommand === "deactivate") {
    setCooMode(VAULT_PATH, "internal");
    ok("Deactivated COO (internal orchestration engaged)");
  } else if (subcommand === "status") {
    const configPath = path.join(VAULT_PATH, "_system/CONFIG.md");
    let mode = "internal";
    let active = "none";
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf-8");
      const modeMatch = content.match(/\| orchestration_mode\s*\|\s*([a-zA-Z0-9_\-]+)\s*\|/);
      if (modeMatch) mode = modeMatch[1];
      const activeMatch = content.match(/\| active_coo\s*\|\s*([a-zA-Z0-9_\-]+)\s*\|/);
      if (activeMatch) active = activeMatch[1];
    }
    section("COO Status");
    console.log(`Mode:       ${c.bold}${mode}${c.reset}`);
    console.log(`Active COO: ${c.bold}${active}${c.reset}\n`);
    console.log("Installed Orchestrators:");
    if (fs.existsSync(sysOrchestrators)) {
      let count = 0;
      for (const entry of fs.readdirSync(sysOrchestrators, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          console.log(`  - ${entry.name}`);
          count++;
        }
      }
      if (count === 0) console.log("  (none)");
    } else {
      console.log("  (none)");
    }
    console.log();
  } else {
    fail(`Unknown coo subcommand: ${subcommand}`);
  }
}

// hq tools [--non-interactive]
// Check, install, and authenticate: Claude CLI, Gemini CLI, OpenCode
async function cmdTools(nonInteractive = false): Promise<void> {
  console.log(`\n${c.bold}━━━ CLI Tools Setup ━━━${c.reset}\n`);

  const hasNpm = !!sh("npm --version 2>/dev/null");
  if (!hasNpm) {
    warn("npm not found — CLI tools may not install correctly");
  }

  // ── Helper: check if a CLI is authenticated ─────────────────────────────
  function isClaudeAuthed(): boolean {
    // Claude stores auth state in ~/.config/anthropic/ or ~/.claude/
    const configPaths = [
      path.join(os.homedir(), ".config", "anthropic"),
      path.join(os.homedir(), ".claude"),
    ];
    return configPaths.some(p => fs.existsSync(p) && fs.readdirSync(p).some(f => f.includes("auth") || f.includes("credentials") || f.includes("token")));
  }

  function isGeminiAuthed(): boolean {
    const geminiDir = path.join(os.homedir(), ".gemini");
    return fs.existsSync(geminiDir) &&
      fs.readdirSync(geminiDir).some(f => f.includes("oauth") || f.includes("credentials") || f.includes("token"));
  }

  // ── 1. Claude CLI ────────────────────────────────────────────────────────
  section("Claude CLI");
  let claudeV = sh("claude --version 2>/dev/null");
  if (!claudeV) {
    warn("Claude CLI not found");
    if (nonInteractive || confirmInstall("Install Claude CLI? (npm install -g @anthropic-ai/claude-code)")) {
      info("Installing Claude CLI...");
      spawnSync("npm", ["install", "-g", "@anthropic-ai/claude-code"], { stdio: "inherit" });
      claudeV = sh("claude --version 2>/dev/null");
      claudeV ? ok(`Claude CLI installed: ${claudeV}`) : fail("Installation failed — install manually: npm install -g @anthropic-ai/claude-code");
    } else {
      info("Skipped. Install with: npm install -g @anthropic-ai/claude-code");
    }
  } else {
    ok(`Claude CLI: ${claudeV}`);
  }

  if (claudeV) {
    if (isClaudeAuthed()) {
      ok("Claude CLI: authenticated");
    } else {
      warn("Claude CLI: not authenticated");
      if (nonInteractive) {
        info("Run 'claude auth login' to authenticate after setup");
      } else {
        info("Opening Claude authentication...");
        spawnSync("claude", ["auth", "login"], { stdio: "inherit" });
        isClaudeAuthed() ? ok("Claude CLI: authenticated") : warn("Authentication incomplete — run 'claude auth login' manually");
      }
    }
  }

  // ── 2. Gemini CLI ────────────────────────────────────────────────────────
  section("Gemini CLI");
  let geminiV = sh("gemini --version 2>/dev/null");
  if (!geminiV) {
    warn("Gemini CLI not found");
    if (nonInteractive || confirmInstall("Install Gemini CLI? (npm install -g @google/gemini-cli)")) {
      info("Installing Gemini CLI...");
      spawnSync("npm", ["install", "-g", "@google/gemini-cli"], { stdio: "inherit" });
      geminiV = sh("gemini --version 2>/dev/null");
      geminiV ? ok(`Gemini CLI installed: ${geminiV}`) : fail("Installation failed — install manually: npm install -g @google/gemini-cli");
    } else {
      info("Skipped. Install with: npm install -g @google/gemini-cli");
    }
  } else {
    ok(`Gemini CLI: ${geminiV}`);
  }

  if (geminiV) {
    if (isGeminiAuthed()) {
      ok("Gemini CLI: authenticated");
    } else {
      warn("Gemini CLI: not authenticated");
      if (nonInteractive) {
        info("Run 'gemini auth' to authenticate after setup");
      } else {
        info("Opening Gemini authentication (browser OAuth flow)...");
        spawnSync("gemini", ["auth"], { stdio: "inherit" });
        isGeminiAuthed() ? ok("Gemini CLI: authenticated") : warn("Authentication incomplete — run 'gemini auth' manually");
      }
    }

    // Google Workspace Extension
    section("Google Workspace Extension");
    const geminiDir = path.join(os.homedir(), ".gemini");
    const settingsFile = path.join(geminiDir, "settings.json");
    const hasWorkspaceExt = fs.existsSync(settingsFile) &&
      fs.readFileSync(settingsFile, "utf-8").includes("workspace");

    if (hasWorkspaceExt) {
      ok("Google Workspace extension: already configured");
    } else {
      info("Provides access to: Keep, Drive, Calendar, Gmail, Docs, Sheets");
      if (nonInteractive || confirmInstall("Install Google Workspace extension for Gemini CLI?")) {
        const installResult = spawnSync("gemini", [
          "extensions", "install",
          "https://github.com/gemini-cli-extensions/workspace"
        ], { stdio: "inherit" });
        if (installResult.status === 0) {
          ok("Google Workspace extension installed");
        } else {
          warn("Extension install returned non-zero — follow any browser prompts and re-run if needed");
        }
      } else {
        info("Skipped. Install manually: gemini extensions install https://github.com/gemini-cli-extensions/workspace");
      }
    }

    // Write Obsidian MCP server to ~/.gemini/settings.json
    section("Gemini MCP Config");
    const vaultPath = process.env.VAULT_PATH ?? path.resolve(REPO_ROOT, ".vault");
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsFile)) {
      try { settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8")); } catch {}
    }
    const mcpServers = (settings.mcpServers as Record<string, unknown> ?? {});
    if (!mcpServers.obsidian) {
      mcpServers.obsidian = {
        command: "npx",
        args: ["-y", "@mauricio.wolff/mcp-obsidian", vaultPath],
        description: "Obsidian vault access (notes, jobs, delegation)",
        trust: true,
      };
      settings.mcpServers = mcpServers;
      fs.mkdirSync(geminiDir, { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), "utf-8");
      ok(`Written ~/.gemini/settings.json with Obsidian MCP server`);
    } else {
      ok("Obsidian MCP server already in ~/.gemini/settings.json");
    }
  }

  // ── 3. OpenCode ──────────────────────────────────────────────────────────
  section("OpenCode");
  let ocV = sh("opencode --version 2>/dev/null | head -1");
  if (!ocV) {
    warn("OpenCode not found (optional)");
    if (!nonInteractive && confirmInstall("Install OpenCode? (npm install -g opencode)")) {
      spawnSync("npm", ["install", "-g", "opencode"], { stdio: "inherit" });
      ocV = sh("opencode --version 2>/dev/null | head -1");
      ocV ? ok(`OpenCode installed: ${ocV}`) : warn("Install may have failed — check: https://opencode.ai");
    } else {
      info("Skipped (optional). Install with: npm install -g opencode");
    }
  } else {
    ok(`OpenCode: ${ocV}`);
  }

  console.log();
}

function confirmInstall(prompt: string): boolean {
  // Pass prompt as a positional argument to avoid bash interpolation injection
  try {
    const result = spawnSync("bash", ["-c", 'read -p "$1 [Y/n] " -n 1 -r; echo "$REPLY"', "--", prompt], {
      stdio: ["inherit", "pipe", "inherit"],
    });
    const reply = result.stdout?.toString().trim() ?? "";
    return !reply || reply.toLowerCase() === "y";
  } catch { return false; }
}

// hq setup
async function cmdSetup(): Promise<void> {
  const VAULT_PATH = process.env.VAULT_PATH ?? path.resolve(REPO_ROOT, ".vault");
  console.log(`\nSetting up vault at: ${VAULT_PATH}\n`);

  const dirs = [
    "_system", "_system/orchestrators",
    "_jobs/pending", "_jobs/running", "_jobs/done", "_jobs/failed",
    "_delegation/pending", "_delegation/claimed", "_delegation/completed",
    "_delegation/relay-health", "_delegation/coo_inbox", "_delegation/coo_outbox",
    "_threads/active", "_threads/archived",
    "_approvals/pending", "_approvals/resolved",
    "_logs", "_usage/daily", "_embeddings", "_agent-sessions", "_moc", "_templates",
    "Notebooks/Memories", "Notebooks/Projects", "Notebooks/Daily Digest",
    "Notebooks/AI Intelligence", "Notebooks/Insights", "Notebooks/Discord Memory",
  ];

  let created = 0;
  for (const dir of dirs) {
    const full = path.join(VAULT_PATH, dir);
    if (!fs.existsSync(full)) {
      fs.mkdirSync(full, { recursive: true });
      console.log(`  Created: ${dir}/`);
      created++;
    }
  }
  if (created === 0) info("All directories already exist.");

  const systemFiles: Record<string, string> = {
    "_system/SOUL.md": `---\nnoteType: system-file\nfileName: soul\nversion: 1\npinned: true\n---\n# SOUL - Agent Identity\n\nYou are a personal AI assistant and knowledge management agent. You operate locally on the user's machine, managing a structured Obsidian vault as your knowledge base.\n\n## Core Principles\n\n1. **Knowledge-first**: Always check existing notes before creating new ones.\n2. **Structured thinking**: Use frontmatter metadata consistently.\n3. **Local-first**: All data stays on the local machine.\n`,
    "_system/MEMORY.md": `---\nnoteType: system-file\nfileName: memory\nversion: 1\npinned: true\n---\n# Agent Memory\n\n## Key Facts\n\n_No facts stored yet._\n\n## Active Goals\n\n_No active goals._\n`,
    "_system/PREFERENCES.md": `---\nnoteType: system-file\nfileName: preferences\nversion: 1\npinned: true\n---\n# User Preferences\n\n_No preferences configured yet._\n`,
    "_system/HEARTBEAT.md": `---\nnoteType: system-file\nfileName: heartbeat\nversion: 1\nlastProcessed: null\n---\n# Heartbeat\n\nWrite actionable tasks here. The daemon processes this file every 2 minutes.\n\n## Pending Actions\n\n_No pending actions._\n`,
    "_system/CONFIG.md": `---\nnoteType: system-file\nfileName: config\nversion: 1\npinned: false\n---\n# Configuration\n\n| Key | Value |\n|-----|-------|\n| DEFAULT_MODEL | gemini-2.5-flash |\n| orchestration_mode | internal |\n| active_coo         |          |\n`,
    "_system/DIGEST-TOPICS.md": `---\nnoteType: system-file\nfileName: digest-topics\nversion: 1\npinned: false\n---\n# Digest Topics\n\nTopics of interest for daily web digests.\n\n## Topics\n\n_No topics configured yet._\n`,
  };

  let seeded = 0;
  for (const [rel, content] of Object.entries(systemFiles)) {
    const full = path.join(VAULT_PATH, rel);
    if (!fs.existsSync(full)) {
      fs.writeFileSync(full, content, "utf-8");
      console.log(`  Seeded: ${rel}`);
      seeded++;
    }
  }

  // .gitkeep files
  for (const dir of ["_jobs/pending","_jobs/running","_jobs/done","_jobs/failed","_delegation/pending","_delegation/claimed","_delegation/completed","_threads/active","_threads/archived","_logs"]) {
    const gk = path.join(VAULT_PATH, dir, ".gitkeep");
    if (!fs.existsSync(gk)) fs.writeFileSync(gk, "", "utf-8");
  }

  console.log();
  ok(`Vault ready at ${VAULT_PATH} (${created} dirs created, ${seeded} files seeded)`);
}

// hq init [--non-interactive] [--vault <path>] [--repo-url <url>]
async function cmdInit(argv: string[]): Promise<void> {
  const nonInteractive = argv.includes("--non-interactive");
  const vaultIdx = argv.indexOf("--vault");
  const repoIdx = argv.indexOf("--repo-url");
  const customVault = vaultIdx >= 0 ? argv[vaultIdx + 1] : undefined;
  const repoUrl = repoIdx >= 0 ? argv[repoIdx + 1] : "https://github.com/CalvinMagezi/agent-hq";

  console.log(`\n${c.bold}━━━ Agent HQ — First-Time Setup ━━━${c.reset}\n`);

  // 1. Prerequisite checks
  section("Checking prerequisites");
  const bunV = sh("bun --version 2>/dev/null");
  const gitV = sh("git --version 2>/dev/null");
  if (!bunV) {
    fail("Bun not found. Install from: https://bun.sh");
    process.exit(1);
  }
  ok(`Bun ${bunV}`);
  if (!gitV) {
    fail("Git not found. Install from: https://git-scm.com");
    process.exit(1);
  }
  ok(`Git ${gitV.split(" ")[2] ?? gitV}`);

  // 2. Ensure we're in the repo (or clone it)
  section("Repository");
  const inRepo = fs.existsSync(path.join(REPO_ROOT, "package.json")) &&
    fs.existsSync(path.join(REPO_ROOT, "apps/agent"));

  if (!inRepo) {
    const installDir = customVault
      ? path.resolve(customVault, "..")
      : path.join(os.homedir(), "agent-hq");
    info(`Cloning agent-hq to ${installDir}...`);
    try {
      spawnSync("git", ["clone", repoUrl, installDir], { stdio: nonInteractive ? "pipe" : "inherit" });
      ok("Repository cloned");
      info(`Change to that directory and re-run: hq init`);
      return;
    } catch {
      fail("Clone failed. Check your internet connection or repo URL.");
      process.exit(1);
    }
  }
  ok(`Repository root: ${REPO_ROOT}`);

  // 3. Install dependencies
  section("Dependencies");
  info("Running bun install...");
  const installResult = spawnSync(process.execPath, ["install"], {
    cwd: REPO_ROOT, stdio: nonInteractive ? "pipe" : "inherit",
  });
  if (installResult.status !== 0) {
    fail("bun install failed");
    process.exit(1);
  }
  ok("Dependencies installed");

  // 4. CLI Tools (Claude, Gemini, OpenCode)
  section("CLI Tools");
  await cmdTools(nonInteractive);

  // 5. Scaffold vault
  section("Vault");
  if (customVault) process.env.VAULT_PATH = customVault;
  await cmdSetup();

  // 6. Print .env.local templates
  section("Environment variables");
  const agentEnv = path.join(REPO_ROOT, "apps/agent/.env.local");
  const relayEnv = path.join(REPO_ROOT, "apps/discord-relay/.env.local");

  if (!fs.existsSync(agentEnv)) {
    const tpl = `# apps/agent/.env.local\nVAULT_PATH=${customVault ?? path.join(REPO_ROOT, ".vault")}\nOPENROUTER_API_KEY=\nGEMINI_API_KEY=\nDEFAULT_MODEL=gemini-2.5-flash\n`;
    fs.writeFileSync(agentEnv, tpl, "utf-8");
    ok(`Created ${agentEnv}`);
    warn("Fill in OPENROUTER_API_KEY or GEMINI_API_KEY before starting the agent");
  } else {
    info(`${agentEnv} already exists (skipped)`);
  }

  if (!fs.existsSync(relayEnv)) {
    const tpl = `# apps/discord-relay/.env.local\nDISCORD_BOT_TOKEN=\nDISCORD_USER_ID=\nVAULT_PATH=${customVault ?? path.join(REPO_ROOT, ".vault")}\n`;
    fs.writeFileSync(relayEnv, tpl, "utf-8");
    ok(`Created ${relayEnv}`);
    warn("Fill in DISCORD_BOT_TOKEN and DISCORD_USER_ID before starting the relay");
  } else {
    info(`${relayEnv} already exists (skipped)`);
  }

  // 7. Install launchd daemons (macOS only)
  if (process.platform === "darwin") {
    section("Daemons (macOS launchd)");
    await cmdInstall("all");
  }

  // 8. Install CLI to PATH
  section("CLI");
  await cmdInstallCli();

  // 9. Final health check
  console.log();
  await cmdHealth();

  console.log(`\n${c.bold}${c.green}You're ready!${c.reset} Run ${c.bold}hq${c.reset} to start chatting.\n`);
}

// hq daemon [start|stop|status|logs [N]]
async function cmdDaemon(sub?: string, arg?: string): Promise<void> {
  const daemonScript = path.join(SCRIPTS_DIR, "agent-hq-daemon.ts");

  const daemonPidVal = (): string | null => {
    if (!fs.existsSync(DAEMON_PID)) return null;
    const p = fs.readFileSync(DAEMON_PID, "utf-8").trim();
    return p && isAlive(p) ? p : null;
  };

  if (!sub || sub === "status") {
    const pid = daemonPidVal();
    pid
      ? ok(`Daemon running (PID ${pid}, uptime: ${uptime(pid)})`)
      : fail("Daemon not running");
    return;
  }

  if (sub === "start") {
    const pid = daemonPidVal();
    if (pid) { warn(`Daemon already running (PID ${pid})`); return; }
    const log = fs.openSync(DAEMON_LOG, "a");
    const child = (await import("child_process")).spawn(
      process.execPath, [daemonScript],
      { cwd: REPO_ROOT, stdio: ["ignore", log, log], detached: true }
    );
    child.unref();
    fs.writeFileSync(DAEMON_PID, String(child.pid), "utf-8");
    await sleep(1000);
    daemonPidVal()
      ? ok(`Daemon started (PID ${child.pid})`)
      : fail("Daemon failed to start — run: hq daemon logs");
    return;
  }

  if (sub === "stop") {
    const pid = daemonPidVal();
    if (!pid) { warn("Daemon not running"); return; }
    sh(`kill ${pid} 2>/dev/null`);
    await sleep(500);
    if (fs.existsSync(DAEMON_PID)) fs.rmSync(DAEMON_PID);
    ok(`Daemon stopped (PID ${pid})`);
    return;
  }

  if (sub === "logs") {
    const n = arg ? parseInt(arg, 10) : 40;
    section(`Daemon — last ${n} lines`);
    if (fs.existsSync(DAEMON_LOG)) {
      console.log(fs.readFileSync(DAEMON_LOG, "utf-8").split("\n").slice(-n).join("\n") || "(empty)");
    } else {
      dim("(no daemon log yet — has it been started?)");
    }
    return;
  }

  fail(`Unknown daemon subcommand: ${sub}`);
  info("Usage: hq daemon [start|stop|status|logs [N]]");
}

// hq help
function cmdHelp(): void {
  console.log(`
${c.bold}hq${c.reset} — Agent HQ CLI

${c.bold}USAGE${c.reset}
  hq <command> [target] [options]

${c.bold}FIRST-TIME SETUP${c.reset}
  hq init                       Full interactive setup (vault + tools + daemons)
  hq init --non-interactive     Unattended setup — safe for agent execution
  hq tools                      Install & authenticate Claude/Gemini/OpenCode CLIs
  hq tools --non-interactive    Auto-install all tools silently
  hq setup                      Scaffold vault directories and system files only
  hq install-cli                Symlink hq to ~/.local/bin/hq (add to PATH)

${c.bold}CHAT${c.reset}
  hq                            Interactive chat session (default)
  hq chat                       Interactive chat session

${c.bold}SERVICE MANAGEMENT${c.reset}
  hq status                     Status of all services                 (alias: s)
  hq start  [target]            Start services                         targets: agent, relay, whatsapp, relay-server, all
  hq stop   [target]            Stop services
  hq restart [target]           Restart services                       (alias: r)
  hq fg     [target]            Run a service in the foreground

${c.bold}WHATSAPP${c.reset}
  hq wa                         Start WhatsApp in foreground (for QR scan / debug)
  hq wa reset                   Clear conversation thread
  hq wa reauth                  Clear credentials & re-scan QR         (alias: clear-auth)
  hq wa status                  WhatsApp service status
  hq wa logs [N]                WhatsApp adapter logs
  hq wa errors [N]              WhatsApp adapter error logs

${c.bold}BACKGROUND DAEMON${c.reset}
  hq daemon start               Start the background daemon
  hq daemon stop                Stop the background daemon
  hq daemon status              Check if the daemon is running
  hq daemon logs [N]            Last N daemon log lines (default 40)

${c.bold}LOGS${c.reset}
  hq logs   [target] [N]        Last N log lines (default 30)          (alias: l)
  hq errors [target] [N]        Last N error lines (default 20)        (alias: e)
  hq follow [target]            Live-tail logs                         (alias: f)

${c.bold}PROCESSES & HEALTH${c.reset}
  hq ps                         All managed processes                  (alias: p)
  hq health                     Full health check                      (alias: h)
  hq kill                       Force-kill all processes               (alias: k)
  hq clean                      Remove stale locks & orphans           (alias: c)

${c.bold}DAEMONS (macOS launchd auto-start)${c.reset}
  hq install   [target]         Install launchd daemons
  hq uninstall [target]         Remove launchd daemons

${c.bold}COO MANAGEMENT${c.reset}
  hq coo install <url>          Install a COO orchestrator
  hq coo uninstall <name>       Remove COO (preserves memory)
  hq coo activate <name>        Switch to external orchestration
  hq coo deactivate             Switch to internal orchestration
  hq coo status                 Show status and installed COOs

${c.bold}EXAMPLES${c.reset}
  hq                            Start chatting
  hq wa                         WhatsApp foreground (scan QR, debug)
  hq start whatsapp             Start WhatsApp as background service
  hq start all                  Start everything
  hq wa reset                   Clear WhatsApp conversation
  hq wa reauth                  Wipe WhatsApp auth, re-scan QR
  hq restart                    Restart everything
  hq logs whatsapp 50           Last 50 WhatsApp log lines
  hq follow                     Live-tail all logs
  hq health                     Full system health report
`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const [cmd, arg1, arg2] = process.argv.slice(2);

switch (cmd) {
  case undefined:
  case "chat":
    await cmdChat(); break;

  case "status": case "s":
    await cmdStatus(); break;

  case "start":
    await cmdStart(arg1); break;

  case "stop":
    await cmdStop(arg1); break;

  case "restart": case "r":
    await cmdRestart(arg1); break;

  case "logs": case "l":
    await cmdLogs(arg1, arg2 ? parseInt(arg2, 10) : 30); break;

  case "errors": case "e":
    await cmdErrors(arg1, arg2 ? parseInt(arg2, 10) : 20); break;

  case "follow": case "f":
    await cmdFollow(arg1); break;

  case "ps": case "p":
    await cmdPs(); break;

  case "health": case "h":
    await cmdHealth(); break;

  case "kill": case "k":
    await cmdKill(); break;

  case "clean": case "c":
    await cmdClean(); break;

  case "fg":
    await cmdFg(arg1); break;

  case "whatsapp": case "wa":
    if (arg1 === "reset") { await cmdWaReset(); }
    else if (arg1 === "reauth" || arg1 === "clear-auth") { await cmdWaReauth(); }
    else if (arg1 === "status") { await cmdStatus("whatsapp"); }
    else if (arg1 === "logs") { await cmdLogs("whatsapp", arg2 ? parseInt(arg2, 10) : 30); }
    else if (arg1 === "errors") { await cmdErrors("whatsapp", arg2 ? parseInt(arg2, 10) : 20); }
    else { await cmdWhatsApp(); }
    break;

  case "install":
    await cmdInstall(arg1); break;

  case "uninstall":
    await cmdUninstall(arg1); break;

  case "install-cli":
    await cmdInstallCli(); break;

  case "coo":
    await cmdCoo(arg1, arg2); break;

  case "tools": case "t":
    await cmdTools(process.argv.includes("--non-interactive")); break;

  case "setup":
    await cmdSetup(); break;

  case "init":
    await cmdInit(process.argv.slice(3)); break;

  case "daemon": case "d":
    await cmdDaemon(arg1, arg2); break;

  case "help": case "--help": case "-h":
    cmdHelp(); break;

  default:
    fail(`Unknown command: ${cmd}`);
    console.log(`Run ${c.bold}hq help${c.reset} for usage.`);
    process.exit(1);
}

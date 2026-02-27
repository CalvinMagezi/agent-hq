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

const AGENT_DAEMON = "com.agent-hq.agent";
const RELAY_DAEMON = "com.agent-hq.discord-relay";

const AGENT_LOG = path.join(os.homedir(), "Library/Logs/hq-agent.log");
const AGENT_ERR = path.join(os.homedir(), "Library/Logs/hq-agent.error.log");
const RELAY_LOG = path.join(os.homedir(), "Library/Logs/discord-relay.log");
const RELAY_ERR = path.join(os.homedir(), "Library/Logs/discord-relay.error.log");

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

function uptime(pid: string): string {
  return sh(`ps -o etime= -p ${pid} 2>/dev/null`).trim() || "?";
}

function resolveTargets(target?: string): Array<"agent" | "relay"> {
  if (!target || target === "all") return ["agent", "relay"];
  if (target === "agent") return ["agent"];
  if (target === "relay") return ["relay"];
  warn(`Unknown target "${target}" — expected agent, relay, or all`);
  return [];
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
function findAllInstances(target: "agent" | "relay"): string[] {
  const dir = target === "agent" ? HQ_DIR : RELAY_DIR;
  const pids = new Set<string>();

  // Method 1: pgrep by command matching the app directory
  for (const pid of sh(`pgrep -f "${dir}" 2>/dev/null`).split("\n").filter(Boolean)) {
    // Exclude our own hq.ts process
    const cmdline = sh(`ps -o command= -p ${pid} 2>/dev/null`);
    if (cmdline && !cmdline.includes("hq.ts") && !cmdline.includes("scripts/hq")) {
      pids.add(pid);
    }
  }

  // Method 2: lsof to find processes with cwd in the app directory
  for (const line of sh(`lsof +D "${dir}" -t 2>/dev/null`).split("\n").filter(Boolean)) {
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
async function killAllInstances(target: "agent" | "relay"): Promise<number> {
  const daemon = target === "agent" ? AGENT_DAEMON : RELAY_DAEMON;
  const label = target === "agent" ? "HQ Agent" : "Relay";
  let killed = 0;

  // 1. Stop via launchctl
  sh(`launchctl stop "${daemon}" 2>/dev/null`);

  // 2. Kill the primary daemon PID and its entire process tree
  const primaryPid = target === "agent" ? agentPid() : relayPid();
  if (primaryPid) {
    killed += killProcessTree(primaryPid, `${label} (primary)`);
  }

  // 3. Sweep for any remaining instances (duplicates, orphans, zombies)
  await sleep(300);
  const remaining = findAllInstances(target);
  for (const pid of remaining) {
    if (isAlive(pid)) {
      killed += killProcessTree(pid, `${label} (stale instance)`);
    }
  }

  // 4. Final pkill sweep as a safety net
  const dir = target === "agent" ? HQ_DIR : RELAY_DIR;
  sh(`pkill -9 -f "bun.*${dir}/index.ts" 2>/dev/null`);
  sh(`pkill -9 -f "node.*${dir}/index.ts" 2>/dev/null`);

  return killed;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

// hq  |  hq chat
async function cmdChat(): Promise<void> {
  const chatScript = path.join(SCRIPTS_DIR, "agent-hq-chat.ts");
  spawnSync(process.execPath, [chatScript], { stdio: "inherit", env: process.env });
}

// hq status  |  hq s
async function cmdStatus(): Promise<void> {
  console.log(`\n${c.bold}━━━ Agent HQ Status ━━━${c.reset}\n`);

  const ap = agentPid();
  const rp = relayPid();

  ap
    ? ok(`HQ Agent   running  ${c.gray}(PID: ${ap}, uptime: ${uptime(ap)})${c.reset}`)
    : fail("HQ Agent   not running");

  rp
    ? ok(`Relay      running  ${c.gray}(PID: ${rp}, uptime: ${uptime(rp)})${c.reset}`)
    : fail("Relay      not running");

  console.log();
}

// hq start [agent|relay|all]
async function cmdStart(target?: string): Promise<void> {
  for (const t of resolveTargets(target)) {
    const daemon = t === "agent" ? AGENT_DAEMON : RELAY_DAEMON;
    const label = t === "agent" ? "HQ Agent" : "Relay";
    const pid = t === "agent" ? agentPid() : relayPid();

    if (pid) { warn(`${label} already running (PID: ${pid})`); continue; }

    sh(`launchctl start "${daemon}" 2>/dev/null`);
    await sleep(2500);

    const newPid = t === "agent" ? agentPid() : relayPid();
    newPid
      ? ok(`${label} started (PID: ${newPid})`)
      : fail(`${label} failed to start — run: hq errors ${t}`);
  }
}

// hq stop [agent|relay|all]
async function cmdStop(target?: string): Promise<void> {
  for (const t of resolveTargets(target)) {
    const label = t === "agent" ? "HQ Agent" : "Relay";

    const killed = await killAllInstances(t);
    await sleep(500);

    // Verify nothing survived
    const survivors = findAllInstances(t).filter(p => isAlive(p));
    if (survivors.length > 0) {
      warn(`${label}: ${survivors.length} process(es) still alive after stop, force-killing...`);
      for (const pid of survivors) {
        sh(`kill -9 ${pid} 2>/dev/null`);
      }
      await sleep(300);
    }

    killed > 0
      ? console.log(`⏹️   ${label} stopped (killed ${killed} process${killed > 1 ? "es" : ""})`)
      : console.log(`⏹️   ${label} stopped (was not running)`);
  }
}

// hq restart [agent|relay|all]  |  hq r
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
    const label = t === "agent" ? "HQ Agent" : "Relay";
    const zombies = findAllInstances(t).filter(p => isAlive(p));
    if (zombies.length > 0) {
      warn(`${label}: ${zombies.length} zombie(s) found, force-killing before start...`);
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
    const label = t === "agent" ? "HQ Agent" : "Relay";
    const allPids = findAllInstances(t).filter(p => isAlive(p));
    if (allPids.length > 1) {
      warn(`${label}: detected ${allPids.length} instances — killing extras...`);
      const primary = t === "agent" ? agentPid() : relayPid();
      for (const pid of allPids) {
        if (pid !== primary) {
          killProcessTree(pid, `${label} (duplicate)`);
        }
      }
    } else if (allPids.length === 1) {
      ok(`${label}: single instance confirmed (PID ${allPids[0]})`);
    }
  }
}

// hq logs [agent|relay|all] [N]  |  hq l
async function cmdLogs(target?: string, n = 30): Promise<void> {
  for (const t of resolveTargets(target)) {
    const file = t === "agent" ? AGENT_LOG : RELAY_LOG;
    const label = t === "agent" ? "HQ Agent" : "Relay";
    section(`${label} — last ${n} lines`);
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf-8").split("\n").slice(-n).join("\n");
      console.log(lines || "(empty)");
    } else {
      dim("(no log file yet)");
    }
  }
}

// hq errors [agent|relay|all] [N]  |  hq e
async function cmdErrors(target?: string, n = 20): Promise<void> {
  for (const t of resolveTargets(target)) {
    const file = t === "agent" ? AGENT_ERR : RELAY_ERR;
    const label = t === "agent" ? "HQ Agent" : "Relay";
    section(`${label} errors — last ${n} lines`);
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf-8").split("\n").slice(-n).join("\n");
      console.log(lines || "(no errors)");
    } else {
      dim("(no error log yet)");
    }
  }
}

// hq follow [agent|relay|all]  |  hq f
async function cmdFollow(target?: string): Promise<void> {
  const targets = resolveTargets(target);
  const files = targets.map(t => t === "agent" ? AGENT_LOG : RELAY_LOG);
  section(`Following ${targets.join(" + ")} logs (Ctrl+C to stop)`);
  spawnSync("tail", ["-f", ...files], { stdio: "inherit" });
}

// hq ps  |  hq p
async function cmdPs(): Promise<void> {
  section("Agent HQ Processes");
  console.log();

  const ap = agentPid();
  const rp = relayPid();
  console.log(ap
    ? `🤖  HQ Agent     PID ${ap} (uptime: ${uptime(ap)})`
    : `🤖  HQ Agent     not running`);
  console.log(rp
    ? `📡  Relay        PID ${rp} (uptime: ${uptime(rp)})`
    : `📡  Relay        not running`);

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
  const ap = path.join(LAUNCH_AGENTS, `${AGENT_DAEMON}.plist`);
  const rp = path.join(LAUNCH_AGENTS, `${RELAY_DAEMON}.plist`);
  fs.existsSync(ap) ? ok("HQ Agent daemon: installed") : warn("HQ Agent daemon: not installed  (run: hq install agent)");
  fs.existsSync(rp) ? ok("Relay daemon: installed") : warn("Relay daemon: not installed     (run: hq install relay)");

  section("Recent HQ Agent Logs");
  dim(fs.existsSync(AGENT_LOG)
    ? fs.readFileSync(AGENT_LOG, "utf-8").split("\n").slice(-5).join("\n")
    : "(no logs yet)");

  section("Recent Relay Logs");
  dim(fs.existsSync(RELAY_LOG)
    ? fs.readFileSync(RELAY_LOG, "utf-8").split("\n").slice(-5).join("\n")
    : "(no logs yet)");

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

// hq fg [agent|relay]
async function cmdFg(target = "agent"): Promise<void> {
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
      execSync(`git clone ${arg} ${targetDir}`, { stdio: "inherit" });
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

// hq help
function cmdHelp(): void {
  console.log(`
${c.bold}hq${c.reset} — Agent HQ CLI

${c.bold}USAGE${c.reset}
  hq[command][target][options]

${c.bold}CHAT(default when no command given)${c.reset}
  hq                            Interactive chat session
  hq chat                       Interactive chat session

${c.bold}SERVICE MANAGEMENT${c.reset}
  hq status                     Status of all services(alias: s)
  hq start[agent | relay | all]   Start services
  hq stop[agent | relay | all]   Stop services
  hq restart[agent | relay | all]  Restart services(alias: r)
  hq fg[agent | relay]           Run a service in foreground

${c.bold}LOGS${c.reset}
  hq logs[agent | relay | all][N]  Last N log lines(default 30)(alias: l)
  hq errors[agent | relay | all][N]  Last N error lines(default 20)(alias: e)
  hq follow[agent | relay | all]      Live tail logs(alias: f)

${c.bold}PROCESSES & HEALTH${c.reset}
  hq ps                         All managed processes(alias: p)
  hq health                     Full health check(alias: h)
  hq kill                       Force - kill all processes(alias: k)
  hq clean                      Remove stale locks & orphans(alias: c)

${c.bold}SETUP${c.reset}
  hq install[agent | relay | all]  Install launchd daemons(auto - start on login)
  hq uninstall[agent | relay | all]  Remove launchd daemons
  hq install - cli                  Symlink hq to ~/.local/bin / hq

${c.bold}COO MANAGEMENT${c.reset}
  hq coo install < url > Install a new COO orchestrator
  hq coo uninstall < name > Remove COO(preserves memory)
  hq coo activate < name > Switch to external orchestration
  hq coo deactivate             Switch to internal orchestration
  hq coo status                 Show status and installed COOs

${c.bold}EXAMPLES${c.reset}
  hq                    # Start chatting
  hq restart            # Restart everything
  hq restart relay      # Restart just the relay
  hq logs relay 50      # Last 50 relay log lines
  hq follow             # Live tail all logs
  hq ps                 # See all running processes
  hq health             # Full system health report
  hq install            # Install both daemons(first - time setup)
  hq install - cli        # Add 'hq' to PATH
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

  case "install":
    await cmdInstall(arg1); break;

  case "uninstall":
    await cmdUninstall(arg1); break;

  case "install-cli":
    await cmdInstallCli(); break;

  case "coo":
    await cmdCoo(arg1, arg2); break;

  case "help": case "--help": case "-h":
    cmdHelp(); break;

  default:
    fail(`Unknown command: ${cmd}`);
    console.log(`Run ${c.bold}hq help${c.reset} for usage.`);
    process.exit(1);
}

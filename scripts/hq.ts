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

import {
  REPO_ROOT, RELAY_DIR, HQ_DIR, SCRIPTS_DIR, LAUNCH_AGENTS, LOG_DIR, PID_DIR,
  WA_DIR, TG_DIR, RELAY_SERVER_DIR, WA_AUTH_DIR, PWA_DIR,
  AGENT_DAEMON, RELAY_DAEMON, RELAY_SERVER_DAEMON,
  DAEMON_LOG, DAEMON_PID, RELAY_LOCK,
  c, sh, isAlive, sleep,
  ok, fail, warn, info, dim, section,
  agentPid, relayPid, whatsappPid, relayServerPid,
  uptime, resolveTargets, serviceInfo, killProcessTree, findAllInstances, killAllInstances,
  readLine, isPortInUse, parseEnvFile, writeEnvFile, confirmInstall,
  type ServiceTarget,
} from "./hq/shared.js";

// hq mcp [status|remove]
async function cmdMcp(sub?: string): Promise<void> {
  const { mcpStatus, mcpInstall, mcpRemove } = await import("./hq/mcpInstaller.js");
  const nonInteractive = process.argv.includes("--non-interactive");
  if (sub === "status" || sub === "--status") await mcpStatus(REPO_ROOT);
  else if (sub === "remove" || sub === "--remove") await mcpRemove(REPO_ROOT);
  else await mcpInstall(REPO_ROOT, nonInteractive);
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

  // ── Linux: use detached spawn instead of launchd ────────────────────────────
  if (process.platform !== "darwin") {
    const { spawn } = await import("child_process");
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.mkdirSync(PID_DIR, { recursive: true });

    for (const t of targets) {
      const svc = serviceInfo(t);
      const existingPid = svc.pid();
      if (existingPid) { warn(`${svc.label} already running (PID: ${existingPid})`); continue; }

      const entryFile = t === "relay-server" ? "src/index.ts" : "index.ts";
      const out = fs.openSync(svc.log, "a");
      const err = fs.openSync(svc.err, "a");

      const child = spawn(process.execPath, [entryFile], {
        cwd: svc.dir,
        detached: true,
        stdio: ["ignore", out, err],
        env: { ...process.env },
      });
      child.unref();

      const pidFile = path.join(PID_DIR, `${svc.daemon}.pid`);
      fs.writeFileSync(pidFile, String(child.pid), "utf-8");
      ok(`${svc.label} started (PID: ${child.pid}) — logs: ${svc.log}`);
    }
    return;
  }

  // If starting whatsapp or telegram, ensure relay-server is started first
  if ((targets.includes("whatsapp") || targets.includes("telegram")) && !targets.includes("relay-server")) {
    const rsPid = relayServerPid();
    if (!rsPid) {
      info("Starting relay server (required by adapter)...");
      const rsRegistered = sh(`launchctl list 2>/dev/null | grep "${RELAY_SERVER_DAEMON}"`);
      if (!rsRegistered) {
        const plistDst = path.join(LAUNCH_AGENTS, `${RELAY_SERVER_DAEMON}.plist`);
        if (fs.existsSync(plistDst)) sh(`launchctl load "${plistDst}" 2>/dev/null`);
      } else {
        sh(`launchctl start "${RELAY_SERVER_DAEMON}" 2>/dev/null`);
      }
      await sleep(2500);
      const rsNew = relayServerPid();
      rsNew
        ? ok(`Relay Server started (PID: ${rsNew})`)
        : warn("Relay Server may not have started — adapter may fail to connect");
    }
  }

  for (const t of targets) {
    const svc = serviceInfo(t);
    const pid = svc.pid();

    if (pid) { warn(`${svc.label} already running (PID: ${pid})`); continue; }

    // Check if the service is registered in launchd; if not, load the plist first
    const registered = sh(`launchctl list 2>/dev/null | grep "${svc.daemon}"`);
    if (!registered) {
      const plistDst = path.join(LAUNCH_AGENTS, `${svc.daemon}.plist`);
      if (fs.existsSync(plistDst)) {
        sh(`launchctl load "${plistDst}" 2>/dev/null`);
        await sleep(1000);
      } else {
        fail(`${svc.label} plist not found — run: hq install ${t}`);
        continue;
      }
    } else {
      sh(`launchctl start "${svc.daemon}" 2>/dev/null`);
    }
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

    // On Linux, also clean up the PID file written by cmdStart
    if (process.platform === "linux") {
      const pidFile = path.join(PID_DIR, `${svc.daemon}.pid`);
      if (fs.existsSync(pidFile)) fs.rmSync(pidFile);
      sh(`systemctl --user stop agent-hq-${t}.service 2>/dev/null`);
    }

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

  const icons: Record<ServiceTarget, string> = { agent: "🤖", relay: "📡", "relay-server": "🔌", "vault-sync": "🔄", whatsapp: "📱", telegram: "✈️", pwa: "🌐", "pwa-ws": "⚡", "icloud-bridge": "☁️" };
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
  const ocV = sh("opencode --version 2>/dev/null").split("\n")[0];
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
  // ── Linux: generate systemd unit files ─────────────────────────────────────
  if (process.platform === "linux") {
    const systemdDir = path.join(os.homedir(), ".config", "systemd", "user");
    fs.mkdirSync(systemdDir, { recursive: true });

    for (const t of resolveTargets(target)) {
      const svc = serviceInfo(t);
      const entryFile = t === "relay-server" ? "src/index.ts" : "index.ts";
      const unitName = `agent-hq-${t}.service`;
      const unitPath = path.join(systemdDir, unitName);
      const unitContent = [
        "[Unit]",
        `Description=Agent HQ — ${svc.label}`,
        "After=network.target",
        "",
        "[Service]",
        "Type=simple",
        "Restart=on-failure",
        "RestartSec=5",
        `WorkingDirectory=${svc.dir}`,
        `ExecStart=${process.execPath} ${entryFile}`,
        `StandardOutput=append:${svc.log}`,
        `StandardError=append:${svc.err}`,
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n");

      fs.writeFileSync(unitPath, unitContent, "utf-8");
      sh("systemctl --user daemon-reload 2>/dev/null");
      sh(`systemctl --user enable --now ${unitName} 2>/dev/null`);
      ok(`${svc.label} systemd unit installed: ${unitPath}`);
      info(`  Control with: systemctl --user start|stop|status ${unitName}`);
    }
    return;
  }

  // ── macOS: launchd ──────────────────────────────────────────────────────────
  for (const t of resolveTargets(target)) {
    const svc = serviceInfo(t);
    const plistSrc = path.join(svc.dir, `${svc.daemon}.plist`);
    const plistDst = path.join(LAUNCH_AGENTS, `${svc.daemon}.plist`);

    if (!fs.existsSync(plistSrc)) {
      fail(`${svc.label} plist not found: ${plistSrc}`);
      continue;
    }
    fs.mkdirSync(LAUNCH_AGENTS, { recursive: true });
    fs.copyFileSync(plistSrc, plistDst);
    sh(`launchctl load "${plistDst}" 2>/dev/null`);
    ok(`${svc.label} daemon installed and started`);
  }
}

// hq uninstall [agent|relay|all]
async function cmdUninstall(target?: string): Promise<void> {
  for (const t of resolveTargets(target)) {
    const svc = serviceInfo(t);

    if (process.platform === "darwin") {
      const plistDst = path.join(LAUNCH_AGENTS, `${svc.daemon}.plist`);
      sh(`launchctl unload "${plistDst}" 2>/dev/null`);
      if (fs.existsSync(plistDst)) {
        fs.rmSync(plistDst);
        ok(`${svc.label} daemon uninstalled`);
      } else {
        warn(`${svc.label} daemon was not installed`);
      }
    } else if (process.platform === "linux") {
      const unitName = `agent-hq-${t}.service`;
      sh(`systemctl --user disable --now ${unitName} 2>/dev/null`);
      const unitPath = path.join(os.homedir(), ".config", "systemd", "user", unitName);
      if (fs.existsSync(unitPath)) {
        fs.rmSync(unitPath);
        sh("systemctl --user daemon-reload 2>/dev/null");
        ok(`${svc.label} systemd unit uninstalled`);
      } else {
        warn(`${svc.label} systemd unit was not installed`);
      }
    } else {
      warn(`Uninstall not supported on ${process.platform} — stop the process manually`);
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

// hq fg [agent|relay|whatsapp|telegram]
async function cmdFg(target = "agent"): Promise<void> {
  if (target === "whatsapp") {
    const waDir = path.join(REPO_ROOT, "apps/relay-adapter-whatsapp");
    console.log("Starting WhatsApp relay in foreground (Ctrl+C to stop)...");
    spawnSync(process.execPath, ["src/index.ts"], { cwd: waDir, stdio: "inherit" });
    return;
  }

  if (target === "telegram") {
    console.log("Starting Telegram relay in foreground (Ctrl+C to stop)...");
    spawnSync(process.execPath, ["src/index.ts"], { cwd: TG_DIR, stdio: "inherit" });
    return;
  }

  const isAgent = target === "agent";
  const daemon = isAgent ? AGENT_DAEMON : RELAY_DAEMON;
  const dir = isAgent ? HQ_DIR : RELAY_DIR;
  const label = isAgent ? "HQ Agent" : "Relay";
  const pid = isAgent ? agentPid() : relayPid();

  if (process.platform === "darwin") sh(`launchctl stop "${daemon}" 2>/dev/null`);
  if (process.platform === "linux") sh(`systemctl --user stop agent-hq-${target}.service 2>/dev/null`);
  if (pid) { try { process.kill(Number(pid), "SIGTERM"); } catch { /* already dead */ } }
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

// hq telegram / hq tg — start relay server (if needed) + Telegram adapter in foreground
async function cmdTelegram(): Promise<void> {
  const { spawn } = await import("child_process");
  const RELAY_PORT = 18900;
  const VAULT_PATH = process.env.VAULT_PATH || path.join(REPO_ROOT, ".vault");

  // ── Load env vars from .env.local files so relay server gets them ─
  const relayEnv: Record<string, string> = { ...process.env as Record<string, string>, VAULT_PATH };
  for (const envDir of [
    TG_DIR,
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
      env: { ...relayEnv, AGENT_WS_PORT: "0" },
    });

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

  // ── Start Telegram adapter ─────────────────────────────────────
  console.log();
  info("Starting Telegram adapter (Ctrl+C to stop both)...");
  console.log();

  const tgChild = spawn(process.execPath, ["src/index.ts"], {
    cwd: TG_DIR,
    stdio: "inherit",
    env: { ...process.env },
  });

  const cleanup = () => {
    tgChild.kill("SIGTERM");
    if (relayChild) relayChild.kill("SIGTERM");
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const tgExitCode = await new Promise<number>((resolve) => {
    tgChild.on("exit", (code) => resolve(code ?? 0));
  });

  if (relayChild) {
    info("Stopping relay server...");
    relayChild.kill("SIGTERM");
    await sleep(1000);
    if (!relayChild.killed) relayChild.kill("SIGKILL");
    ok("Relay server stopped");
  }

  process.exit(tgExitCode);
}

// hq tg reset — clear Telegram conversation thread
async function cmdTgReset(): Promise<void> {
  const VAULT_PATH = process.env.VAULT_PATH || path.join(REPO_ROOT, ".vault");
  const threadFile = path.join(VAULT_PATH, "_threads", "tg-self.md");
  const stateFile = path.join(TG_DIR, ".telegram-state.json");

  if (fs.existsSync(threadFile)) {
    fs.rmSync(threadFile);
    ok("Telegram conversation thread cleared");
  } else {
    info("No Telegram thread file found (already clean)");
  }

  if (fs.existsSync(stateFile)) {
    fs.rmSync(stateFile);
    ok("Telegram state file cleared");
  }

  console.log();
  info("If the adapter is running, send !reset in Telegram or restart the service:");
  dim("  hq restart telegram");
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

// ─── hq diagram ──────────────────────────────────────────────────────────────

/**
 * hq diagram — Fast diagram pipeline for relay harnesses.
 *
 * Single bash command that any harness (Claude Code, Gemini CLI) can call
 * for instant diagram creation. Handles the full pipeline:
 *   generate → export SVG → convert PNG → output [FILE:] marker
 *
 * Usage:
 *   hq diagram flow "Step 1" "Step 2" "Decision?" "Step 3"
 *   hq diagram map ./src
 *   hq diagram deps .
 *   hq diagram routes ./app
 *   hq diagram render existing.drawit
 *   hq diagram create --title "My Arch" --nodes "Frontend,Backend,DB" --edges "Frontend>Backend,Backend>DB"
 */
async function cmdDiagram(sub?: string, ...rest: string[]): Promise<void> {
  const VAULT_PATH = process.env.VAULT_PATH ?? path.resolve(REPO_ROOT, ".vault");
  const diagramsDir = path.join(VAULT_PATH, "Notebooks", "Diagrams");
  const outputsDir = path.join(VAULT_PATH, "_jobs", "outputs");
  fs.mkdirSync(diagramsDir, { recursive: true });
  fs.mkdirSync(outputsDir, { recursive: true });

  // Resolve drawit binary
  let drawitBin: string;
  try {
    drawitBin = execSync("which drawit", { encoding: "utf-8" }).trim();
  } catch {
    // Try common fallback locations before giving up
    const fallbacks = ["/opt/homebrew/bin/drawit", "/usr/local/bin/drawit"];
    const found = fallbacks.find(p => fs.existsSync(p));
    if (!found) {
      fail("DrawIt CLI not found. Install: npm i -g @chamuka-labs/drawit-cli");
      return;
    }
    drawitBin = found;
  }

  function runDrawIt(args: string[]): string {
    try {
      return execSync(
        `"${drawitBin}" ${args.map(a => `"${a}"`).join(" ")}`,
        { encoding: "utf-8", timeout: 60_000, stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
    } catch (err: any) {
      const stderr = err.stderr?.toString()?.trim() ?? "";
      fail(`drawit: ${stderr || err.message}`);
      return "";
    }
  }

  function safeName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9\-_ ]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "diagram";
  }

  function uniqueOutput(ext: string): string {
    const hash = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    return path.join(outputsDir, `diagram-${hash}.${ext}`);
  }

  async function svgToPng(svgPath: string): Promise<string> {
    const { Resvg } = await import("@resvg/resvg-js");
    const svgContent = fs.readFileSync(svgPath, "utf-8");
    const resvg = new Resvg(svgContent);
    const pngData = resvg.render().asPng();
    const pngPath = uniqueOutput("png");
    fs.writeFileSync(pngPath, pngData);
    return pngPath;
  }

  async function exportAndConvert(drawitPath: string, name: string): Promise<void> {
    const svgPath = uniqueOutput("svg");
    runDrawIt(["export", drawitPath, "--format", "svg", "--output", svgPath, "--padding", "20"]);
    const pngPath = await svgToPng(svgPath);
    const displayName = `${name}.png`;
    console.log(drawitPath);
    console.log(`[FILE: ${pngPath} | ${displayName}]`);
  }

  if (!sub || sub === "help" || sub === "--help") {
    console.log(`
${c.bold}hq diagram${c.reset} — Fast diagram pipeline

${c.bold}USAGE${c.reset}
  hq diagram flow "Step 1" "Step 2" "Decision?" "End"     Quick flowchart
  hq diagram map [path]                                     Codebase architecture map
  hq diagram deps [path]                                    Package dependency graph
  hq diagram routes [path]                                  Next.js route tree
  hq diagram render <file.drawit>                           Export existing .drawit to PNG
  hq diagram create --title "Name" --nodes "A,B,C" --edges "A>B,B>C"

${c.bold}OUTPUT${c.reset}
  Prints [FILE: /path/to/diagram.png | name.png] for auto-sharing via Discord/WhatsApp.
  Source .drawit files saved to .vault/Notebooks/Diagrams/
`);
    return;
  }

  switch (sub) {
    case "flow": {
      const steps = rest.filter(s => !s.startsWith("--"));
      const nameIdx = rest.indexOf("--name");
      const name = nameIdx >= 0 && rest[nameIdx + 1] ? safeName(rest[nameIdx + 1]) : "flow";
      const drawitPath = path.join(diagramsDir, `${name}.drawit`);
      if (steps.length === 0) { fail("No steps provided. Usage: hq diagram flow \"Step 1\" \"Step 2\" ..."); return; }
      runDrawIt(["flow", ...steps, "--output", drawitPath]);
      await exportAndConvert(drawitPath, name);
      break;
    }

    case "map": {
      const targetPath = rest[0] || ".";
      const dirName = safeName(path.basename(path.resolve(targetPath)));
      const drawitPath = path.join(diagramsDir, `${dirName}-map.drawit`);
      const args = ["map", targetPath, "--output", drawitPath];
      // Pass through flags
      for (let i = 1; i < rest.length; i++) {
        if (rest[i].startsWith("--")) { args.push(rest[i]); if (rest[i + 1] && !rest[i + 1].startsWith("--")) { args.push(rest[++i]); } }
      }
      runDrawIt(args);
      await exportAndConvert(drawitPath, `${dirName}-map`);
      break;
    }

    case "deps": {
      const targetPath = rest[0] || ".";
      const dirName = safeName(path.basename(path.resolve(targetPath)));
      const drawitPath = path.join(diagramsDir, `${dirName}-deps.drawit`);
      runDrawIt(["deps", targetPath, "--output", drawitPath]);
      await exportAndConvert(drawitPath, `${dirName}-deps`);
      break;
    }

    case "routes": {
      const targetPath = rest[0] || ".";
      const dirName = safeName(path.basename(path.resolve(targetPath)));
      const drawitPath = path.join(diagramsDir, `${dirName}-routes.drawit`);
      runDrawIt(["routes", targetPath, "--output", drawitPath]);
      await exportAndConvert(drawitPath, `${dirName}-routes`);
      break;
    }

    case "render": {
      const filePath = rest[0];
      if (!filePath || !fs.existsSync(filePath)) { fail(`File not found: ${filePath}`); return; }
      const name = safeName(path.basename(filePath, ".drawit"));
      await exportAndConvert(filePath, name);
      break;
    }

    case "create": {
      // Parse --title, --nodes, --edges flags for quick structured diagrams
      let title = "diagram";
      let nodesStr = "";
      let edgesStr = "";
      let theme: "dark" | "light" = "dark";

      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--title" && rest[i + 1]) title = rest[++i];
        else if (rest[i] === "--nodes" && rest[i + 1]) nodesStr = rest[++i];
        else if (rest[i] === "--edges" && rest[i + 1]) edgesStr = rest[++i];
        else if (rest[i] === "--theme" && rest[i + 1]) theme = rest[++i] as "dark" | "light";
      }

      if (!nodesStr) { fail("--nodes required. Usage: hq diagram create --title 'Name' --nodes 'A,B,C' --edges 'A>B,B>C'"); return; }

      const nodeLabels = nodesStr.split(",").map(s => s.trim()).filter(Boolean);
      const edgePairs = edgesStr ? edgesStr.split(",").map(s => s.trim()).filter(Boolean) : [];

      // Generate NDJSON with automatic grid layout
      const isDark = theme === "dark";
      const bg = isDark ? "#0a0f1e" : "#ffffff";
      const textColor = isDark ? "#e2e8f0" : "#333333";
      const palette = isDark
        ? ["#1e3a5f", "#2d4a3f", "#4a2d5f", "#5f3a1e", "#1e5f5a", "#5f1e3a"]
        : ["#e3f2fd", "#e8f5e9", "#f3e5f5", "#fff3e0", "#e0f7fa", "#fce4ec"];
      const strokePalette = isDark
        ? ["#3b82f6", "#34d399", "#a78bfa", "#f59e0b", "#22d3ee", "#f87171"]
        : ["#1976d2", "#4caf50", "#7b1fa2", "#ff9800", "#00bcd4", "#f44336"];

      const cols = Math.ceil(Math.sqrt(nodeLabels.length));
      const nodeW = 180, nodeH = 60, gapX = 80, gapY = 80, pad = 80;
      const canvasW = pad * 2 + cols * nodeW + (cols - 1) * gapX;
      const rows = Math.ceil(nodeLabels.length / cols);
      const canvasH = pad * 2 + rows * nodeH + (rows - 1) * gapY;

      const lines: string[] = [];
      lines.push(JSON.stringify({ width: canvasW, height: canvasH, background: bg, metadata: { name: title, diagramType: "architecture" } }));

      const nodeIds: Record<string, string> = {};
      nodeLabels.forEach((label, i) => {
        const id = `n${i}`;
        nodeIds[label] = id;
        const col = i % cols, row = Math.floor(i / cols);
        const x = pad + col * (nodeW + gapX), y = pad + row * (nodeH + gapY);
        const ci = i % palette.length;
        lines.push(JSON.stringify({
          id, type: "node",
          position: { x, y }, size: { width: nodeW, height: nodeH },
          shape: "rectangle", zIndex: 2,
          style: { fillStyle: palette[ci], strokeStyle: strokePalette[ci], lineWidth: 2, fillOpacity: 1, strokeOpacity: 1, cornerRadii: { topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 8 } },
          text: { content: label, fontSize: 14, fontFamily: "sans-serif", color: textColor, textAlign: "center", verticalAlign: "middle" },
        }));
      });

      edgePairs.forEach((pair, i) => {
        const [from, to] = pair.split(">").map(s => s.trim());
        const sourceId = nodeIds[from], targetId = nodeIds[to];
        if (!sourceId || !targetId) return;
        lines.push(JSON.stringify({
          id: `e${i}`, type: "edge", source: sourceId, target: targetId, zIndex: 1,
          style: { strokeStyle: isDark ? "#94a3b8" : "#64748B", lineWidth: 2, arrowheadEnd: true, strokeOpacity: 0.8, routing: "orthogonal" },
        }));
      });

      const name = safeName(title);
      const drawitPath = path.join(diagramsDir, `${name}.drawit`);
      fs.writeFileSync(drawitPath, lines.join("\n") + "\n", "utf-8");
      await exportAndConvert(drawitPath, name);
      break;
    }

    default:
      fail(`Unknown diagram subcommand: ${sub}. Run 'hq diagram help' for usage.`);
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
      if (!nonInteractive && confirmInstall("Install Google Workspace extension for Gemini CLI?")) {
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
        if (nonInteractive) info("Or run: hq tools  (interactive mode) to install with guided prompts");
      }
    }

    // Write HQ MCP server to ~/.gemini/settings.json
    section("Gemini MCP Config");
    const vaultPath = process.env.VAULT_PATH ?? path.resolve(REPO_ROOT, ".vault");
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsFile)) {
      try { settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8")); } catch (e) {
        warn(`Could not parse ${settingsFile}: ${e} — skipping Gemini MCP config update`);
        return;
      }
    }
    const mcpServers = (settings.mcpServers as Record<string, unknown> ?? {});
    
    // Add HQ MCP server
    const mcpScript = path.join(REPO_ROOT, "packages/hq-tools/src/mcp.ts");
    const { resolveCredentials } = await import("./hq/mcpInstaller.js");
    const { openrouterApiKey } = resolveCredentials(REPO_ROOT);
    
    mcpServers["agent-hq"] = {
      command: "bun",
      args: ["run", mcpScript],
      env: {
        VAULT_PATH: vaultPath,
        OPENROUTER_API_KEY: openrouterApiKey,
        SECURITY_PROFILE: "standard"
      },
      trust: true,
    };
    
    settings.mcpServers = mcpServers;
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), "utf-8");
    ok(`Updated ~/.gemini/settings.json with Agent HQ MCP server`);
  }

  // ── 3. OpenCode ──────────────────────────────────────────────────────────
  section("OpenCode");
  let ocV = sh("opencode --version 2>/dev/null").split("\n")[0];
  if (!ocV) {
    warn("OpenCode not found (optional)");
    if (!nonInteractive && confirmInstall("Install OpenCode? (npm install -g opencode)")) {
      spawnSync("npm", ["install", "-g", "opencode"], { stdio: "inherit" });
      ocV = sh("opencode --version 2>/dev/null").split("\n")[0];
      ocV ? ok(`OpenCode installed: ${ocV}`) : warn("Install may have failed — check: https://opencode.ai");
    } else {
      info("Skipped (optional). Install with: npm install -g opencode");
    }
  } else {
    ok(`OpenCode: ${ocV}`);
  }

  console.log();
}

// hq agent [harness]
// Spawn a fully contextualized agent session with vault context + governance
async function cmdAgent(harness: string = "hq"): Promise<void> {
  const VAULT_PATH = process.env.VAULT_PATH ?? path.resolve(REPO_ROOT, ".vault");

  // ── HQ harness: already fully contextualized via relay ───────────────────
  if (harness === "hq") {
    spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts/agent-hq-chat.ts")], {
      stdio: "inherit",
      env: { ...process.env, RELAY_SERVER: "1", VAULT_PATH },
    });
    return;
  }

  // ── Read vault context ────────────────────────────────────────────────────
  const readVault = (file: string) => {
    try { return fs.readFileSync(path.join(VAULT_PATH, file), "utf-8"); } catch { return ""; }
  };

  const soul = readVault("_system/SOUL.md");
  const memory = readVault("_system/MEMORY.md");
  const prefs = readVault("_system/PREFERENCES.md");

  // Read up to 5 pinned notes
  const pinnedSnippets: string[] = [];
  try {
    const notebookDirs = ["Notebooks/Projects", "Notebooks/Memories", "Notebooks"];
    for (const dir of notebookDirs) {
      const full = path.join(VAULT_PATH, dir);
      if (!fs.existsSync(full)) continue;
      for (const f of fs.readdirSync(full).filter(f => f.endsWith(".md")).slice(0, 10)) {
        const content = fs.readFileSync(path.join(full, f), "utf-8");
        if (content.includes("pinned: true")) {
          pinnedSnippets.push(`- **${f.replace(".md", "")}**: ${content.slice(0, 300).replace(/\n/g, " ").trim()}`);
          if (pinnedSnippets.length >= 5) break;
        }
      }
      if (pinnedSnippets.length >= 5) break;
    }
  } catch { /* ignore */ }

  // ── Build context string ──────────────────────────────────────────────────
  const context = `# Agent-HQ: Vault Context & Governance

## Identity
${soul || "You are a helpful AI assistant."}

## Memory
${memory || "(no memory yet)"}

## Preferences
${prefs || "(no preferences set)"}

${pinnedSnippets.length ? `## Pinned Notes\n${pinnedSnippets.join("\n")}\n` : ""}

## Governance — Security Profile: STANDARD

You are operating as part of the Agent-HQ ecosystem with STANDARD security.

### Rules
- **Never** delete files, force-push git, drop databases, or run irreversible scripts without an approval.
- **Never** expose or log API keys or secrets from env vars.
- For risky operations, write an approval request FIRST and wait before proceeding.

### Approval Request Format
When you need approval for a risky action, write this file and WAIT:

File path: ${VAULT_PATH}/_approvals/pending/approval-{timestamp}-{hash}.md

\`\`\`yaml
---
approvalId: approval-{timestamp}-{hash}
title: Short description of the action
description: What you want to do and why
toolName: bash
riskLevel: low|medium|high|critical
status: pending
createdAt: {ISO timestamp}
timeoutMinutes: 10
---
\`\`\`

Then poll ${VAULT_PATH}/_approvals/resolved/ every 10 seconds. Proceed only when the file appears there with \`status: approved\`.

### Memory Management
To persist a fact: append a new line to ${VAULT_PATH}/_system/MEMORY.md under the appropriate section.

### Vault Path
Your vault is at: ${VAULT_PATH}
`;

  // ── Inject context per harness ────────────────────────────────────────────
  const workDir = process.cwd();

  info(`Launching ${harness} with vault context from ${VAULT_PATH}`);
  console.log();

  switch (harness) {
    case "claude": {
      // Claude Code reads CLAUDE.md from cwd. Prepend vault context under a marker.
      const claudeMdPath = path.join(workDir, "CLAUDE.md");
      const existing = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, "utf-8") : "";
      const START = "<!-- agent-hq:start -->";
      const END = "<!-- agent-hq:end -->";
      const block = `${START}\n${context}\n${END}`;
      const newContent = existing.includes(START)
        ? existing.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block)
        : `${block}\n\n${existing}`;
      fs.writeFileSync(claudeMdPath, newContent);
      spawnSync("claude", [], { stdio: "inherit", cwd: workDir });
      // Remove injected block on exit to avoid polluting project CLAUDE.md permanently
      if (fs.existsSync(claudeMdPath)) {
        const current = fs.readFileSync(claudeMdPath, "utf-8");
        fs.writeFileSync(claudeMdPath, current.replace(new RegExp(`${START}[\\s\\S]*?${END}\n*`), "").trim() + (existing ? "\n" : ""));
      }
      break;
    }

    case "codex":
    case "gemini":
    case "opencode": {
      // Codex, Gemini, and OpenCode all read AGENTS.md from cwd automatically
      const agentsMdPath = path.join(workDir, "AGENTS.md");
      const existingAgents = fs.existsSync(agentsMdPath) ? fs.readFileSync(agentsMdPath, "utf-8") : "";
      const START = "<!-- agent-hq:start -->";
      const END = "<!-- agent-hq:end -->";
      const block = `${START}\n${context}\n${END}`;
      const newAgents = existingAgents.includes(START)
        ? existingAgents.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block)
        : `${block}\n\n${existingAgents}`;
      fs.writeFileSync(agentsMdPath, newAgents);
      spawnSync(harness, [], { stdio: "inherit", cwd: workDir });
      // Clean up injected block
      if (fs.existsSync(agentsMdPath)) {
        const current = fs.readFileSync(agentsMdPath, "utf-8");
        const cleaned = current.replace(new RegExp(`${START}[\\s\\S]*?${END}\n*`), "").trim();
        cleaned ? fs.writeFileSync(agentsMdPath, cleaned + "\n") : fs.unlinkSync(agentsMdPath);
      }
      break;
    }

    default:
      fail(`Unknown harness: ${harness}. Valid: hq, claude, codex, gemini, opencode`);
      process.exit(1);
  }
}

// hq tools vscode
// Build and install the Agent-HQ VS Code extension
async function cmdVsCode(): Promise<void> {
  console.log(`\n${c.bold}━━━ VS Code Extension ━━━${c.reset}\n`);

  const extDir = path.resolve(REPO_ROOT, "apps/vscode-extension");
  if (!fs.existsSync(extDir)) {
    fail("apps/vscode-extension not found — is this the agent-hq repo?");
    process.exit(1);
  }

  const codePaths = [
    "code",
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    "/usr/local/bin/code",
  ];
  const codeBin = codePaths.find(p => !!sh(`"${p}" --version 2>/dev/null | head -1`));
  if (!codeBin) {
    fail("VS Code CLI not found — add it via: Command Palette → 'Shell Command: Install code command in PATH'");
    process.exit(1);
  }
  const codeV = sh(`"${codeBin}" --version 2>/dev/null | head -1`);
  ok(`VS Code: ${codeV}`);

  info("Installing npm dependencies...");
  spawnSync("npm", ["install", "--prefix", extDir, "--quiet"], { stdio: "inherit" });

  info("Compiling TypeScript...");
  const tsc = spawnSync("npx", ["--prefix", extDir, "tsc", "-p", path.join(extDir, "tsconfig.json")], {
    stdio: "inherit",
    cwd: extDir,
  });
  if (tsc.status !== 0) {
    fail("TypeScript compilation failed");
    process.exit(1);
  }
  ok("Compiled");

  info("Packaging extension...");
  const vsce = spawnSync("npx", ["--prefix", extDir, "vsce", "package", "--no-dependencies", "--out", path.join(extDir, "agent-hq-0.2.0.vsix")], {
    stdio: "inherit",
    cwd: extDir,
  });
  if (vsce.status !== 0) {
    fail("Packaging failed");
    process.exit(1);
  }
  ok("Packaged: agent-hq-0.1.0.vsix");

  info("Installing in VS Code...");
  const vsixPath = path.join(extDir, "agent-hq-0.2.0.vsix");
  const install = spawnSync(codeBin, ["--install-extension", vsixPath, "--force"], {
    stdio: "inherit",
  });
  if (install.status !== 0) {
    fail("Installation failed — install manually: code --install-extension apps/vscode-extension/agent-hq-0.1.0.vsix");
    process.exit(1);
  }
  ok("Agent-HQ extension installed!");

  console.log(`\n${c.bold}Ready.${c.reset} Open VS Code and press ${c.bold}Cmd+Shift+A${c.reset} to open the chat.\n`);
  console.log(`  Switch harnesses:  ${c.bold}Cmd+Shift+H${c.reset}`);
  console.log(`  Or via palette:    ${c.bold}Agent-HQ: Open Chat${c.reset} / ${c.bold}Agent-HQ: Switch Harness${c.reset}\n`);
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
    "_system",
    "_jobs/pending", "_jobs/running", "_jobs/done", "_jobs/failed",
    "_delegation/pending",
    "_delegation/pending/claude-code", "_delegation/pending/opencode",
    "_delegation/pending/gemini-cli", "_delegation/pending/any",
    "_delegation/claimed", "_delegation/completed",
    "_delegation/relay-health",
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
  for (const dir of ["_jobs/pending", "_jobs/running", "_jobs/done", "_jobs/failed", "_delegation/pending", "_delegation/pending/claude-code", "_delegation/pending/opencode", "_delegation/pending/gemini-cli", "_delegation/pending/any", "_delegation/claimed", "_delegation/completed", "_threads/active", "_threads/archived", "_logs"]) {
    const gk = path.join(VAULT_PATH, dir, ".gitkeep");
    if (!fs.existsSync(gk)) fs.writeFileSync(gk, "", "utf-8");
  }

  console.log();
  ok(`Vault ready at ${VAULT_PATH} (${created} dirs created, ${seeded} files seeded)`);
}

// hq init [--non-interactive] [--reset] [--vault <path>] [--repo-url <url>]
//         [--skip-ollama] [--skip-tools] [--profile vps|desktop]
async function cmdInit(argv: string[]): Promise<void> {
  // --profile vps is a shorthand for --non-interactive --skip-ollama --skip-tools
  const profile = argv.includes("--profile") ? argv[argv.indexOf("--profile") + 1] : undefined;
  if (profile === "vps") {
    argv = [...argv, "--non-interactive", "--skip-ollama", "--skip-tools"];
  }
  const nonInteractive = argv.includes("--non-interactive") || argv.includes("-y") || !process.stdout.isTTY;
  const doReset = argv.includes("--reset");
  const skipOllama = argv.includes("--skip-ollama");
  const skipTools = argv.includes("--skip-tools");
  const vaultIdx = argv.indexOf("--vault");
  const repoIdx = argv.indexOf("--repo-url");
  const customVault = vaultIdx >= 0 ? argv[vaultIdx + 1] : undefined;
  const repoUrl = repoIdx >= 0 ? argv[repoIdx + 1] : "https://github.com/CalvinMagezi/agent-hq";

  // Load init state (tracks completed steps for idempotency)
  const { InitStateManager } = await import("../packages/hq-cli/src/initState.ts");
  const { runPreflight, ensureOllamaModels } = await import("../packages/hq-cli/src/preflight.ts");
  const { getPlatform } = await import("../packages/hq-cli/src/platform.ts");

  const state = new InitStateManager(REPO_ROOT);
  if (doReset) { state.reset(); info("Init state reset — all steps will re-run."); }

  const platform = getPlatform();

  console.log(`\n${c.bold}━━━ Agent HQ — Setup ━━━${c.reset}`);
  console.log(`${c.dim}Platform: ${platform.os} ${platform.arch} | Service manager: ${platform.serviceManager}${c.reset}\n`);

  // ── Step 1: Preflight (dependency detection + auto-install) ──────────────────
  if (!state.isDone("preflight")) {
    const { allRequiredOk } = await runPreflight(platform.os, { nonInteractive });
    if (!allRequiredOk) {
      fail("Required dependencies missing — fix the above and re-run: hq init");
      process.exit(1);
    }
    state.markDone("preflight");
  } else {
    info("Preflight already complete (run hq init --reset to re-check)");
  }

  // ── Step 2: Ensure we're in the repo ─────────────────────────────────────────
  const inRepo = fs.existsSync(path.join(REPO_ROOT, "package.json")) &&
    fs.existsSync(path.join(REPO_ROOT, "apps/agent"));

  if (!inRepo) {
    section("Repository");
    const installDir = path.join(os.homedir(), "agent-hq");
    info(`Cloning agent-hq to ${installDir}...`);
    const cloneResult = spawnSync("git", ["clone", repoUrl, installDir], {
      stdio: nonInteractive ? "pipe" : "inherit",
    });
    if (cloneResult.status !== 0) {
      fail("Clone failed. Check your internet connection.");
      process.exit(1);
    }
    ok("Repository cloned");
    info(`Now run: cd ${installDir} && hq init`);
    return;
  }
  ok(`Repository: ${REPO_ROOT}`);

  // ── Step 3: bun install ───────────────────────────────────────────────────────
  if (!state.isDone("install")) {
    section("Installing packages");
    const r = spawnSync(process.execPath, ["install"], {
      cwd: REPO_ROOT, stdio: nonInteractive ? "pipe" : "inherit",
    });
    if (r.status !== 0) { fail("bun install failed"); process.exit(1); }
    ok("Packages installed");
    state.markDone("install");
  }

  // ── Step 4: CLI Tools (Claude, Gemini, OpenCode) ─────────────────────────────
  if (!state.isDone("tools")) {
    if (skipTools) {
      info("CLI tools skipped (--skip-tools) — run 'hq tools' interactively to install");
      state.markDone("tools");
    } else {
      section("CLI Tools");
      await cmdTools(nonInteractive);
      state.markDone("tools");
    }
  }

  // ── Step 5: Scaffold vault ────────────────────────────────────────────────────
  if (!state.isDone("vault")) {
    section("Vault");
    if (customVault) process.env.VAULT_PATH = customVault;
    await cmdSetup();
    state.markDone("vault");
  }

  // ── Step 6: Ollama models (optional — local memory features only) ────────────
  if (!state.isDone("models")) {
    if (skipOllama) {
      info("Ollama skipped (--skip-ollama) — local memory features will be unavailable");
      info("Enable later: hq tools ollama");
      state.markDone("models");
    } else if (sh("ollama --version 2>/dev/null")) {
      section("Ollama models");
      await ensureOllamaModels(["qwen3.5:9b", "qwen3.5:2b", "qwen3.5:0.8b"]);
      state.markDone("models");
    } else {
      info("Ollama not installed — skipping local model setup (run 'hq tools ollama' to install)");
      state.markDone("models");
    }
  }

  // ── Step 7: Environment files (with env-var injection for agents) ─────────────
  section("Environment");
  const vaultPath = customVault ?? path.join(REPO_ROOT, ".vault");
  const agentEnv = path.join(REPO_ROOT, "apps/agent/.env.local");
  const relayEnv = path.join(REPO_ROOT, "apps/discord-relay/.env.local");

  if (!fs.existsSync(agentEnv)) {
    // Agents can pass keys via environment variables
    const orKey = process.env.OPENROUTER_API_KEY ?? "";
    const gemKey = process.env.GEMINI_API_KEY ?? "";
    const anKey = process.env.ANTHROPIC_API_KEY ?? "";
    const model = process.env.DEFAULT_MODEL ?? "gemini-2.5-flash";
    fs.writeFileSync(agentEnv,
      `# apps/agent/.env.local\nVAULT_PATH=${vaultPath}\nOPENROUTER_API_KEY=${orKey}\nGEMINI_API_KEY=${gemKey}\nANTHROPIC_API_KEY=${anKey}\nDEFAULT_MODEL=${model}\n`,
      "utf-8"
    );
    ok(`Created ${agentEnv}`);
    if (!orKey && !gemKey && !anKey) info("No API keys set. Relay harnesses (Claude, Codex, Gemini) work without keys. Set OPENROUTER_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY for embeddings & chat fallback.");
  } else {
    info("apps/agent/.env.local exists (skipped)");
  }

  if (!fs.existsSync(relayEnv)) {
    const discordToken = process.env.DISCORD_BOT_TOKEN ?? "";
    const discordUser  = process.env.DISCORD_USER_ID ?? "";
    fs.writeFileSync(relayEnv,
      `# apps/discord-relay/.env.local\nDISCORD_BOT_TOKEN=${discordToken}\nDISCORD_USER_ID=${discordUser}\nVAULT_PATH=${vaultPath}\n`,
      "utf-8"
    );
    ok(`Created ${relayEnv}`);
    if (!discordToken) warn("Set DISCORD_BOT_TOKEN before starting the relay");
  } else {
    info("apps/discord-relay/.env.local exists (skipped)");
  }

  if (!state.isDone("env")) state.markDone("env");
  
  // ── Step 7.5: HQ MCP Server ──────────────────────────────────────────────────
  if (!state.isDone("mcp")) {
    section("MCP Server");
    const { mcpInstall } = await import("./hq/mcpInstaller.js");
    await mcpInstall(REPO_ROOT, nonInteractive);
    state.markDone("mcp");
  }

  // ── Step 8: Background services ───────────────────────────────────────────────
  if (!state.isDone("services")) {
    section(`Services (${platform.serviceManager})`);
    if (platform.serviceManager === "launchd") {
      await cmdInstall("all");
      state.markDone("services");
    } else if (platform.serviceManager === "systemd") {
      await cmdInstall("agent");
      state.markDone("services");
    } else if (platform.serviceManager === "taskscheduler") {
      warn("Windows Task Scheduler integration coming soon — run services manually:");
      info("  hq fg agent");
    } else {
      warn("No service manager detected — run services manually with: hq fg agent");
    }
  }

  // ── Step 9: Install CLI to PATH ───────────────────────────────────────────────
  if (!state.isDone("cli")) {
    section("CLI");
    await cmdInstallCli();
    state.markDone("cli");
  }

  // ── Done ──────────────────────────────────────────────────────────────────────
  const warns = state.warnings;
  if (warns.length) {
    console.log(`\n${c.yellow}Warnings:${c.reset}`);
    warns.forEach(w => warn(w));
  }

  console.log(`
${c.bold}${c.green}━━━ Setup Complete ━━━${c.reset}

  ${c.bold}Next Steps:${c.reset}

  1. Configure API keys:      ${c.bold}hq env${c.reset}
  2. Start chatting:           ${c.bold}hq${c.reset}
  3. Check system health:      ${c.bold}hq doctor${c.reset}
  4. Open web dashboard:       ${c.bold}hq pwa${c.reset}
  5. View vault in Obsidian:   ${c.bold}hq vault open${c.reset}

  Need help?                   ${c.bold}hq help${c.reset}
  Full documentation:          ${c.cyan}https://github.com/CalvinMagezi/agent-hq${c.reset}
`);
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

// hq update [--check] [--force]
async function cmdUpdate(argv: string[]): Promise<void> {
  const checkOnly = argv.includes("--check");
  const force     = argv.includes("--force");

  const pkgPath = path.join(REPO_ROOT, "package.json");
  const currentVersion: string = JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version ?? "unknown";
  const currentCommit = sh("git rev-parse --short HEAD 2>/dev/null") || "unknown";
  const isGitRepo = fs.existsSync(path.join(REPO_ROOT, ".git"));

  console.log(`\n${c.bold}━━━ Agent HQ — Update ━━━${c.reset}\n`);
  info(`Installed:  v${currentVersion} (${currentCommit})`);
  info(`Location:   ${REPO_ROOT}`);

  // ── 1. Fetch latest commit info from GitHub (no npm lag) ──────────────────
  if (!sh("git --version 2>/dev/null")) {
    fail("git is not installed — cannot check for updates");
    process.exit(1);
  }
  info("Checking for updates...");
  const remoteCommit = (() => {
    try {
      return execSync(`git ls-remote https://github.com/CalvinMagezi/agent-hq.git HEAD 2>/dev/null`, { encoding: "utf-8", timeout: 10000 }).split(/\s+/)[0]?.slice(0, 7) ?? "";
    } catch { return ""; }
  })();
  const remoteVersion = sh(`git show origin/main:package.json 2>/dev/null | grep '"version"' | head -1`)
    .match(/"version":\s*"([^"]+)"/)?.[1]
    ?? sh(`npm view @calvin.magezi/agent-hq version 2>/dev/null`);

  if (!remoteCommit && !remoteVersion) {
    warn("Could not reach GitHub. Check your internet connection.");
    if (!force) return;
  }

  const alreadyCurrent = isGitRepo
    ? sh("git rev-parse HEAD 2>/dev/null")?.startsWith(remoteCommit ?? "___")
    : currentVersion === remoteVersion;

  if (alreadyCurrent && !force) {
    ok(`Already up to date — v${currentVersion} (${currentCommit})`);
    return;
  }

  if (remoteVersion && remoteVersion !== currentVersion) {
    console.log(`  ${c.cyan}↑${c.reset}  v${currentVersion} → ${c.bold}v${remoteVersion}${c.reset}`);
  } else if (remoteCommit && remoteCommit !== currentCommit) {
    console.log(`  ${c.cyan}↑${c.reset}  ${currentCommit} → ${c.bold}${remoteCommit}${c.reset} (new commits)`);
  }

  if (checkOnly) {
    info(`Run ${c.bold}hq update${c.reset} to apply.`);
    return;
  }

  // ── 2. Stop running services before updating ──────────────────────────────
  const wasRunning = { agent: !!agentPid(), relay: !!relayPid() };
  if (wasRunning.agent || wasRunning.relay) {
    section("Stopping services");
    await cmdStop("all");
    await sleep(1000);
  }

  // ── 3. Pull latest (git or fresh clone fallback) ──────────────────────────
  section("Pulling latest");
  if (isGitRepo) {
    // Stash any local changes so pull never fails
    const dirty = sh("git status --porcelain 2>/dev/null");
    if (dirty) {
      if (force) {
        info("Local changes detected — stashing before update...");
        const stashResult = spawnSync("git", ["stash", "push", "-m", "hq update auto-stash"], { cwd: REPO_ROOT, stdio: "pipe" });
        if (stashResult.status !== 0) {
          fail(`Could not stash local changes:\n${stashResult.stderr?.toString()}`);
          process.exit(1);
        }
      } else {
        fail("Local changes detected. Use --force to stash and proceed, or commit/discard changes first.");
        process.exit(1);
      }
    }

    // Show what's coming
    sh("git fetch origin main --quiet 2>/dev/null");
    const changelog = sh("git log HEAD..origin/main --oneline 2>/dev/null");
    if (changelog) {
      console.log(`\n${c.dim}Changes:${c.reset}`);
      for (const line of changelog.split("\n").slice(0, 10)) {
        console.log(`  ${c.gray}${line}${c.reset}`);
      }
      console.log();
    }

    const reset = spawnSync("git", ["reset", "--hard", "origin/main"], { cwd: REPO_ROOT, stdio: "pipe" });
    if (reset.status !== 0) {
      fail(`git reset failed:\n${reset.stderr?.toString()}`);
      process.exit(1);
    }
    ok("Repository updated");
  } else {
    // Installed without git (unlikely but possible) — re-clone into tmp then swap
    fail("This installation has no .git directory. Re-install with: bunx @calvin.magezi/agent-hq init --reset");
    process.exit(1);
  }

  // ── 4. Re-install packages ────────────────────────────────────────────────
  section("Installing packages");
  const install = spawnSync(process.execPath, ["install"], { cwd: REPO_ROOT, stdio: "inherit" });
  if (install.status !== 0) {
    fail("bun install failed — run it manually: bun install");
    process.exit(1);
  }

  // ── 5. Post-update migration checks ──────────────────────────────────────
  section("Post-update checks");

  // Ensure vault is still scaffolded (new system files may have been added)
  const vaultPath = process.env.VAULT_PATH ?? path.resolve(REPO_ROOT, ".vault");
  if (fs.existsSync(vaultPath)) {
    await cmdSetup();
    ok("Vault scaffold verified");
  }

  // Re-install systemd units on Linux (unit file content may have changed)
  if (process.platform === "linux" && fs.existsSync(path.join(os.homedir(), ".config", "systemd", "user"))) {
    await cmdInstall("agent");
    info("systemd units refreshed");
  }

  // Re-install CLI symlink if it changed
  await cmdInstallCli();

  // Print new version
  const newVersion = JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version ?? "unknown";
  const newCommit  = sh("git rev-parse --short HEAD 2>/dev/null") || "unknown";
  ok(`Updated to v${newVersion} (${newCommit})`);

  // ── 6. Restart services that were running ────────────────────────────────
  if (wasRunning.agent || wasRunning.relay) {
    section("Restarting services");
    if (wasRunning.agent) await cmdStart("agent");
    if (wasRunning.relay) await cmdStart("relay");
  }

  console.log(`\n${c.green}${c.bold}Update complete.${c.reset} Run ${c.bold}hq doctor${c.reset} to verify.\n`);
}

// ─── New User-Facing Commands ────────────────────────────────────────────────

// hq doctor — diagnose common issues
async function cmdDoctor(): Promise<void> {
  console.log(`\n${c.bold}━━━ Agent HQ — Doctor ━━━${c.reset}\n`);

  let issues = 0;

  // 1. Bun
  const bunVersion = sh("bun --version 2>/dev/null");
  if (bunVersion) {
    ok(`Bun ${bunVersion}`);
  } else {
    fail("Bun not installed — visit https://bun.sh"); issues++;
  }

  // 2. Git
  const gitVersion = sh("git --version 2>/dev/null").replace("git version ", "");
  if (gitVersion) {
    ok(`Git ${gitVersion}`);
  } else {
    fail("Git not installed"); issues++;
  }

  // 3. Vault exists & scaffolded
  const vaultPath = process.env.VAULT_PATH ?? path.resolve(REPO_ROOT, ".vault");
  if (fs.existsSync(path.join(vaultPath, "_system/SOUL.md"))) {
    ok(`Vault scaffolded at ${vaultPath}`);
    // Warn if vault path contains a different user's home directory
    const currentUser = os.userInfo().username;
    const pathUser = vaultPath.match(/\/(?:Users|home)\/([^/]+)\//)?.[1];
    if (pathUser && pathUser !== currentUser) {
      warn(`VAULT_PATH contains username "${pathUser}" but current user is "${currentUser}" — path may be stale from another machine`);
      warn(`  Run: ${c.bold}hq init --reset${c.reset} to regenerate env files with the correct path`);
      issues++;
    }
  } else if (fs.existsSync(vaultPath)) {
    fail(`Vault exists at ${vaultPath} but not scaffolded — run: ${c.bold}hq setup${c.reset}`); issues++;
  } else {
    fail(`No vault found — run: ${c.bold}hq init${c.reset}`); issues++;
  }

  // 4. node_modules
  if (fs.existsSync(path.join(REPO_ROOT, "node_modules"))) {
    ok("Dependencies installed");
  } else {
    fail(`Dependencies missing — run: ${c.bold}bun install${c.reset}`); issues++;
  }

  // 5. API keys
  const agentEnvPath = path.join(REPO_ROOT, "apps/agent/.env.local");
  const agentEnv = parseEnvFile(agentEnvPath);
  const hasOpenRouter = !!agentEnv.OPENROUTER_API_KEY;
  const hasGemini = !!agentEnv.GEMINI_API_KEY;
  const hasAnthropic = !!agentEnv.ANTHROPIC_API_KEY;
  const configuredKeys = [hasOpenRouter && "OpenRouter", hasGemini && "Gemini", hasAnthropic && "Anthropic"].filter(Boolean);
  if (configuredKeys.length > 0) {
    ok(`API keys configured (${configuredKeys.join(" + ")})`);
  } else if (fs.existsSync(agentEnvPath)) {
    warn(`No LLM API keys set — relay harnesses work without keys, but embeddings/chat fallback require one. Run: ${c.bold}hq env${c.reset}`);
  } else {
    warn(`No .env.local found — run: ${c.bold}hq env${c.reset}`);
  }

  // 5b. CLI harness availability
  const harnesses: string[] = [];
  for (const cli of ["claude", "codex", "gemini", "opencode"] as const) {
    try {
      require("child_process").execSync(`which ${cli}`, { stdio: "ignore" });
      harnesses.push(cli);
    } catch { /* not installed */ }
  }
  if (harnesses.length > 0) {
    ok(`CLI harnesses available: ${harnesses.join(", ")}`);
  } else {
    dim("  SKIP  No CLI harnesses found (optional) — install with: hq tools");
  }

  // 6. Discord (optional)
  const relayEnvPath = path.join(REPO_ROOT, "apps/discord-relay/.env.local");
  const relayEnv = parseEnvFile(relayEnvPath);
  if (relayEnv.DISCORD_BOT_TOKEN) {
    ok("Discord bot token configured");
  } else {
    dim("  SKIP  Discord not configured (optional) — set up with: hq env");
  }

  // 7. Ollama
  const ollamaRunning = sh("ollama list 2>/dev/null");
  if (ollamaRunning) {
    ok("Ollama running");
  } else {
    warn("Ollama not running — memory features will be limited");
  }

  // 8. Key ports
  for (const [port, label] of [[4747, "PWA"], [18900, "Relay Server"], [5678, "Agent WS"]] as [number, string][]) {
    if (isPortInUse(port)) {
      ok(`Port ${port} (${label}) in use — service likely running`);
    } else {
      dim(`  ----  Port ${port} (${label}) available`);
    }
  }

  // 9. MCP configured
  const mcpJson = path.join(REPO_ROOT, ".mcp.json");
  if (fs.existsSync(mcpJson)) {
    ok("MCP server configured (.mcp.json)");
  } else {
    warn(`MCP not configured — run: ${c.bold}hq mcp${c.reset}`);
  }

  // 10. Services
  const agent = agentPid();
  const relay = relayPid();
  if (agent) ok(`HQ Agent running (PID ${agent})`);
  else dim("  ----  HQ Agent not running — start with: hq start agent");
  if (relay) ok(`Discord Relay running (PID ${relay})`);
  else dim("  ----  Discord Relay not running — start with: hq start relay");

  // Summary
  console.log();
  if (issues === 0) {
    console.log(`${c.green}${c.bold}All checks passed.${c.reset} Run ${c.bold}hq${c.reset} to start chatting.\n`);
  } else {
    console.log(`${c.yellow}${c.bold}${issues} issue(s) found.${c.reset} Fix the items above and re-run ${c.bold}hq doctor${c.reset}.\n`);
  }
}

// hq env — interactive API key setup
async function cmdEnv(): Promise<void> {
  console.log(`\n${c.bold}━━━ Agent HQ — Environment Setup ━━━${c.reset}\n`);

  const agentEnvPath = path.join(REPO_ROOT, "apps/agent/.env.local");
  const relayEnvPath = path.join(REPO_ROOT, "apps/discord-relay/.env.local");
  const vaultPath = process.env.VAULT_PATH ?? path.resolve(REPO_ROOT, ".vault");

  // Read existing values
  const agentEnv = parseEnvFile(agentEnvPath);
  const relayEnv = parseEnvFile(relayEnvPath);

  const mask = (val: string) => val ? val.slice(0, 8) + "..." : "(not set)";

  // 1. OpenRouter API Key
  console.log(`${c.bold}1. OpenRouter API Key${c.reset} ${c.dim}(optional — routes to any model)${c.reset}`);
  console.log(`   Get one at: ${c.cyan}https://openrouter.ai/keys${c.reset}`);
  console.log(`   Current: ${c.dim}${mask(agentEnv.OPENROUTER_API_KEY || "")}${c.reset}`);
  const orKey = readLine("   Enter key (or press Enter to skip)");
  if (orKey) agentEnv.OPENROUTER_API_KEY = orKey;
  console.log();

  // 2. Gemini API Key (optional)
  console.log(`${c.bold}2. Gemini API Key${c.reset} ${c.dim}(optional — for direct Google Gemini access)${c.reset}`);
  console.log(`   Get one at: ${c.cyan}https://aistudio.google.com/apikey${c.reset}`);
  console.log(`   Current: ${c.dim}${mask(agentEnv.GEMINI_API_KEY || "")}${c.reset}`);
  const gemKey = readLine("   Enter key (or press Enter to skip)");
  if (gemKey) agentEnv.GEMINI_API_KEY = gemKey;
  console.log();

  // 2b. Anthropic API Key (optional)
  console.log(`${c.bold}2b. Anthropic API Key${c.reset} ${c.dim}(optional — for direct Claude API access)${c.reset}`);
  console.log(`   Get one at: ${c.cyan}https://console.anthropic.com/settings/keys${c.reset}`);
  console.log(`   Current: ${c.dim}${mask(agentEnv.ANTHROPIC_API_KEY || "")}${c.reset}`);
  const anKey = readLine("   Enter key (or press Enter to skip)");
  if (anKey) agentEnv.ANTHROPIC_API_KEY = anKey;
  console.log();

  // 3. Default model
  console.log(`${c.bold}3. Default LLM Model${c.reset}`);
  console.log(`   Current: ${c.dim}${agentEnv.DEFAULT_MODEL || "gemini-2.5-flash"}${c.reset}`);
  const model = readLine("   Enter model ID", agentEnv.DEFAULT_MODEL || "gemini-2.5-flash");
  agentEnv.DEFAULT_MODEL = model;
  console.log();

  // 4. Discord (optional)
  console.log(`${c.bold}4. Discord Bot Token${c.reset} ${c.dim}(optional — for Discord relay)${c.reset}`);
  console.log(`   Create a bot at: ${c.cyan}https://discord.com/developers/applications${c.reset}`);
  console.log(`   Current: ${c.dim}${mask(relayEnv.DISCORD_BOT_TOKEN || "")}${c.reset}`);
  const discordToken = readLine("   Enter token (or press Enter to skip)");
  if (discordToken) relayEnv.DISCORD_BOT_TOKEN = discordToken;
  console.log();

  if (discordToken || relayEnv.DISCORD_BOT_TOKEN) {
    console.log(`${c.bold}5. Discord User ID${c.reset} ${c.dim}(your Discord ID — enable Developer Mode in settings)${c.reset}`);
    console.log(`   Current: ${c.dim}${relayEnv.DISCORD_USER_ID || "(not set)"}${c.reset}`);
    const discordUser = readLine("   Enter user ID (or press Enter to skip)");
    if (discordUser) relayEnv.DISCORD_USER_ID = discordUser;
    console.log();
  }

  // Write updated env files
  agentEnv.VAULT_PATH = agentEnv.VAULT_PATH || vaultPath;
  relayEnv.VAULT_PATH = relayEnv.VAULT_PATH || vaultPath;

  writeEnvFile(agentEnvPath, agentEnv);
  ok(`Updated ${agentEnvPath}`);

  writeEnvFile(relayEnvPath, relayEnv);
  ok(`Updated ${relayEnvPath}`);

  console.log(`\n${c.bold}Done.${c.reset} Run ${c.bold}hq doctor${c.reset} to verify, or ${c.bold}hq${c.reset} to start chatting.\n`);
}

// hq pwa — start the web dashboard
async function cmdPwa(): Promise<void> {
  section("HQ Control Center");

  const pwaDir = path.resolve(REPO_ROOT, "apps/hq-control-center");
  if (!fs.existsSync(pwaDir)) {
    fail("apps/hq-control-center not found");
    return;
  }

  // Check deps
  if (!fs.existsSync(path.join(pwaDir, "node_modules"))) {
    info("Installing PWA dependencies...");
    spawnSync(process.execPath, ["install"], { cwd: pwaDir, stdio: "inherit" });
  }

  info("Starting on http://localhost:4747 ...");

  // Open browser after a short delay (macOS / Linux)
  const platform = os.platform();
  setTimeout(() => {
    if (platform === "darwin") {
      spawnSync("open", ["http://localhost:4747"], { stdio: "ignore" });
    } else if (platform === "linux") {
      spawnSync("xdg-open", ["http://localhost:4747"], { stdio: "ignore" });
    }
  }, 2000);

  // Run dev server (blocks)
  const result = spawnSync(process.execPath, ["--cwd", pwaDir, "run", "dev"], {
    stdio: "inherit",
    env: { ...process.env },
  });
  process.exit(result.status ?? 0);
}

// hq vault open — open vault in Obsidian
async function cmdVaultOpen(): Promise<void> {
  const vaultPath = process.env.VAULT_PATH ?? path.resolve(REPO_ROOT, ".vault");

  if (!fs.existsSync(vaultPath)) {
    fail(`Vault not found at ${vaultPath}`);
    info(`Run ${c.bold}hq setup${c.reset} to create it.`);
    return;
  }

  const platform = os.platform();

  if (platform === "darwin") {
    // Check if Obsidian is installed
    const hasObsidian = fs.existsSync("/Applications/Obsidian.app");
    if (hasObsidian) {
      info("Opening vault in Obsidian...");
      spawnSync("open", [`obsidian://open?path=${encodeURIComponent(vaultPath)}`], { stdio: "ignore" });
      ok("Opened vault in Obsidian");
    } else {
      info("Obsidian is not installed.");
      console.log(`\n  Download from: ${c.cyan}https://obsidian.md/download${c.reset}`);
      console.log(`  Then open this folder as a vault: ${c.bold}${vaultPath}${c.reset}\n`);
    }
  } else if (platform === "linux") {
    const hasObsidian = !!sh("which obsidian 2>/dev/null");
    if (hasObsidian) {
      spawnSync("obsidian", [`obsidian://open?path=${encodeURIComponent(vaultPath)}`], { stdio: "ignore" });
      ok("Opened vault in Obsidian");
    } else {
      info("Obsidian is not installed.");
      console.log(`\n  Download from: ${c.cyan}https://obsidian.md/download${c.reset}`);
      console.log(`  Then open this folder as a vault: ${c.bold}${vaultPath}${c.reset}\n`);
    }
  } else {
    console.log(`\n  Open this folder as a vault in Obsidian: ${c.bold}${vaultPath}${c.reset}`);
    console.log(`  Download Obsidian: ${c.cyan}https://obsidian.md/download${c.reset}\n`);
  }
}

// hq plans [list|status <planId>|search <query>]
async function cmdPlans(sub?: string, arg?: string): Promise<void> {
  const vaultPath = process.env.VAULT_PATH ?? path.resolve(REPO_ROOT, ".vault");
  const activeDir = path.join(vaultPath, "_plans", "active");
  const archiveDir = path.join(vaultPath, "_plans", "archive");

  // Helper to read plan frontmatter from a directory
  function readPlan(dir: string): Record<string, any> | null {
    const planMd = path.join(dir, "plan.md");
    if (!fs.existsSync(planMd)) return null;
    try {
      const raw = fs.readFileSync(planMd, "utf-8");
      // Quick frontmatter parse (avoid importing gray-matter for CLI speed)
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return null;
      const fm: Record<string, string> = {};
      for (const line of fmMatch[1].split("\n")) {
        const [k, ...rest] = line.split(":");
        if (k && rest.length) fm[k.trim()] = rest.join(":").trim().replace(/^['"]|['"]$/g, "");
      }
      fm._dir = dir;
      return fm;
    } catch { return null; }
  }

  function scanDir(dir: string): Record<string, any>[] {
    if (!fs.existsSync(dir)) return [];
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name.startsWith("plan-"))
        .map(e => readPlan(path.join(dir, e.name)))
        .filter((p): p is Record<string, any> => p !== null);
    } catch { return []; }
  }

  const statusColors: Record<string, string> = {
    in_progress: c.cyan, delegated: c.yellow, planning: c.cyan,
    completed: c.green, failed: c.red, abandoned: c.gray,
  };

  const modeIcons: Record<string, string> = { act: ">>", sketch: "~~", blueprint: "##" };

  if (sub === "status" && arg) {
    // Show detail for a specific plan
    const plan = readPlan(path.join(activeDir, arg)) ?? readPlan(path.join(archiveDir, arg));
    if (!plan) { fail(`Plan not found: ${arg}`); return; }

    console.log(`\n${c.bold}━━━ Plan: ${plan.title || plan.planId || arg} ━━━${c.reset}\n`);
    console.log(`  ID:       ${plan.planId || arg}`);
    console.log(`  Status:   ${(statusColors[plan.status] || "")}${plan.status}${c.reset}`);
    console.log(`  Mode:     ${modeIcons[plan.planningMode] || ""} ${plan.planningMode || "unknown"}`);
    console.log(`  Project:  ${plan.project || "default"}`);
    if (plan.createdAt) console.log(`  Created:  ${plan.createdAt}`);
    if (plan.updatedAt) console.log(`  Updated:  ${plan.updatedAt}`);
    if (plan.outcome && plan.outcome !== ">-" && plan.outcome !== "|") console.log(`  Outcome:  ${plan.outcome}`);
    console.log();
    return;
  }

  if (sub === "search" && arg) {
    const q = arg.toLowerCase();
    const all = [...scanDir(activeDir), ...scanDir(archiveDir)];
    const matches = all.filter(p =>
      (p.title || "").toLowerCase().includes(q) ||
      (p.planId || "").toLowerCase().includes(q) ||
      (p.project || "").toLowerCase().includes(q)
    );
    if (matches.length === 0) { info(`No plans matching "${arg}"`); return; }
    console.log(`\n${c.bold}━━━ Plans matching "${arg}" (${matches.length}) ━━━${c.reset}\n`);
    for (const p of matches) {
      const color = statusColors[p.status] || "";
      console.log(`  ${color}${(p.status || "?").padEnd(12)}${c.reset} ${(modeIcons[p.planningMode] || "  ")} ${p.title || p.planId}`);
    }
    console.log();
    return;
  }

  // Default: list all plans
  const plans = [...scanDir(activeDir), ...scanDir(archiveDir)];
  if (plans.length === 0) {
    info("No plans found. Create one via HQ tools: hq_call plan_create { ... }");
    return;
  }

  console.log(`\n${c.bold}━━━ Plans (${plans.length}) ━━━${c.reset}\n`);
  for (const p of plans) {
    const color = statusColors[p.status] || "";
    const mode = (modeIcons[p.planningMode] || "  ");
    const id = (p.planId || "???").padEnd(30);
    const status = (p.status || "?").padEnd(12);
    console.log(`  ${color}${status}${c.reset} ${mode} ${c.bold}${p.title || p.planId}${c.reset}`);
    console.log(`  ${c.gray}${id}  ${p.project || "default"}${c.reset}`);
  }
  console.log(`\n  ${c.dim}Use ${c.reset}${c.bold}hq plans status <planId>${c.reset}${c.dim} for details${c.reset}\n`);
}

// hq quickstart — guided first-run walkthrough
async function cmdQuickstart(): Promise<void> {
  console.log(`
${c.bold}━━━ Agent HQ — Quickstart ━━━${c.reset}

Welcome! Let's get you set up step by step.
`);

  // Step 1: Check if init has been run
  const vaultPath = process.env.VAULT_PATH ?? path.resolve(REPO_ROOT, ".vault");
  if (!fs.existsSync(path.join(vaultPath, "_system/SOUL.md"))) {
    info("Vault not set up yet. Running initial setup...\n");
    await cmdInit([]);
    console.log();
  } else {
    ok("Vault already set up");
  }

  // Step 2: API keys
  const agentEnvPath = path.join(REPO_ROOT, "apps/agent/.env.local");
  const agentEnv = parseEnvFile(agentEnvPath);
  if (!agentEnv.OPENROUTER_API_KEY && !agentEnv.GEMINI_API_KEY && !agentEnv.ANTHROPIC_API_KEY) {
    console.log(`\n${c.bold}Step 1: API Keys${c.reset}`);
    console.log("API keys are optional — relay harnesses (Claude, Codex, Gemini) work without them.\nKeys enable embeddings, chat fallback, and vision features.\n");

    const wantsKeys = confirmInstall("Set up API keys now?");
    if (wantsKeys) {
      await cmdEnv();
    } else {
      warn("Skipped — you can set up keys later with: hq env");
    }
  } else {
    ok("API keys already configured");
  }

  // Step 3: Obsidian
  console.log(`\n${c.bold}Step 2: Vault Viewer${c.reset}`);
  console.log("Your vault is a folder of markdown files. You can browse it with Obsidian (recommended) or the web dashboard.\n");

  const wantsObsidian = confirmInstall("Open vault in Obsidian?");
  if (wantsObsidian) {
    await cmdVaultOpen();
  } else {
    info(`You can always open it later with: ${c.bold}hq vault open${c.reset}`);
  }

  // Step 4: PWA
  console.log(`\n${c.bold}Step 3: Web Dashboard${c.reset}`);
  console.log(`The HQ Control Center is a web app for monitoring agents, jobs, and vault content.\n`);
  info(`Start it anytime with: ${c.bold}hq pwa${c.reset}`);

  // Summary
  console.log(`
${c.bold}${c.green}━━━ You're all set! ━━━${c.reset}

  ${c.bold}hq${c.reset}              Start chatting with your AI agent
  ${c.bold}hq start all${c.reset}    Start all background services
  ${c.bold}hq doctor${c.reset}       Check if everything is healthy
  ${c.bold}hq pwa${c.reset}          Open the web dashboard
  ${c.bold}hq help${c.reset}         See all commands
`);
}

// hq help [--all|--agent|advanced]
function cmdHelp(mode?: string): void {
  const showAll = mode === "--all" || mode === "advanced" || mode === "all";
  const showAgent = mode === "--agent" || mode === "agent";

  if (showAgent) {
    console.log(`
# Agent-HQ CLI — Quick Reference for AI Agents
# Run these commands in order:
#
# 1. hq init --non-interactive    First-time setup (idempotent, safe to re-run)
# 2. hq doctor                    Verify everything is configured correctly
# 3. hq env                       Set API keys (if hq doctor reports missing keys)
# 4. hq start agent               Start the HQ agent worker
# 5. hq start relay               Start the Discord relay (optional)
# 6. hq status                    Verify services are running
# 7. hq chat                      Start an interactive chat session
#
# Useful commands:
#   hq health                     Full system health check
#   hq logs [target] [N]          View last N log lines
#   hq restart                    Restart all services
#   hq pwa                        Start web dashboard (port 4747)
#   hq vault open                 Open vault in Obsidian
`);
    return;
  }

  // ── Essential help (default) ──────────────────────────────────────────────
  console.log(`
${c.bold}hq${c.reset} — Agent HQ CLI (local-first AI agent hub)

${c.bold}GETTING STARTED${c.reset}
  hq init                       Full setup (vault + tools + services)
  hq quickstart                 Guided first-run walkthrough
  hq doctor                     Diagnose common issues
  hq env                        Set up API keys interactively

${c.bold}CHAT${c.reset}
  hq                            Start chatting (default command)
  hq agent [harness]            Spawn agent session (hq, claude, gemini, opencode)

${c.bold}SERVICES${c.reset}
  hq status                     Check what's running
  hq start [target]             Start services (agent, relay, all, ...)
  hq stop  [target]             Stop services
  hq restart                    Restart everything

${c.bold}MONITORING${c.reset}
  hq health                     Full health check
  hq logs [target] [N]          View last N log lines
  hq plans [list|status|search] Browse cross-agent plans
  hq pwa                        Open the HQ web dashboard
  hq vault open                 Open vault in Obsidian`);

  if (!showAll) {
    console.log(`
${c.dim}Run ${c.reset}${c.bold}hq help --all${c.reset}${c.dim} for all commands (WhatsApp, Telegram, diagrams, COO, etc.)${c.reset}
${c.dim}Run ${c.reset}${c.bold}hq help --agent${c.reset}${c.dim} for AI agent quick reference${c.reset}
`);
    return;
  }

  // ── Full help (--all) ────────────────────────────────────────────────────
  console.log(`

${c.bold}SETUP & TOOLS${c.reset}
  hq init --non-interactive     Unattended setup (safe for CI / agent execution)
  hq init --profile vps         VPS preset (implies --non-interactive --skip-ollama --skip-tools)
  hq init --skip-ollama         Skip Ollama model pulls (headless/VPS safe)
  hq init --skip-tools          Skip Claude/Gemini/OpenCode CLI install
  hq setup                      Scaffold vault directories only
  hq tools                      Install Claude/Gemini/OpenCode CLIs
  hq mcp                        Auto-install HQ MCP server to all AI agents
  hq mcp status                 Check MCP installation status
  hq mcp remove                 Remove HQ MCP server from configs
  hq install-cli                Symlink hq to ~/.local/bin/hq

${c.bold}WHATSAPP${c.reset}
  hq wa                         Start WhatsApp in foreground (QR scan)
  hq wa reset                   Clear conversation thread
  hq wa reauth                  Clear credentials, re-scan QR
  hq wa status|logs|errors      Status / logs

${c.bold}TELEGRAM${c.reset}
  hq tg                         Start Telegram in foreground
  hq tg reset                   Clear conversation + state
  hq tg status|logs|errors      Status / logs

${c.bold}BACKGROUND DAEMON${c.reset}
  hq daemon start|stop|status   Manage background daemon
  hq daemon logs [N]            Last N daemon log lines

${c.bold}ADVANCED${c.reset}
  hq fg [target]                Run a service in the foreground
  hq ps                         All managed processes
  hq kill                       Force-kill all processes
  hq clean                      Remove stale locks & orphans
  hq install [target]           Install launchd daemons (macOS)
  hq uninstall [target]         Remove launchd daemons
  hq update                     Pull latest from GitHub + restart services
  hq update --check             Check for updates without applying
  hq update --force             Update even with local changes (auto-stashes)

${c.bold}PLANS${c.reset}
  hq plans                      List all cross-agent plans
  hq plans status <planId>      Show plan details
  hq plans search <query>       Search plans by title/project

${c.bold}DIAGRAMS${c.reset}
  hq diagram flow "A" "B" "C?"  Quick flowchart
  hq diagram map|deps|routes    Codebase visualization
  hq diagram render <file>      Export .drawit to PNG

${c.bold}COO MANAGEMENT${c.reset}
  hq coo install|uninstall|activate|deactivate|status

${c.bold}EXAMPLES${c.reset}
  hq                            Start chatting
  hq start all                  Start everything
  hq wa                         WhatsApp foreground (scan QR)
  hq doctor                     Check if everything works
  hq pwa                        Open web dashboard
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

  case "telegram": case "tg":
    if (arg1 === "reset") { await cmdTgReset(); }
    else if (arg1 === "status") { await cmdStatus("telegram"); }
    else if (arg1 === "logs") { await cmdLogs("telegram", arg2 ? parseInt(arg2, 10) : 30); }
    else if (arg1 === "errors") { await cmdErrors("telegram", arg2 ? parseInt(arg2, 10) : 20); }
    else { await cmdTelegram(); }
    break;

  case "install":
    await cmdInstall(arg1); break;

  case "uninstall":
    await cmdUninstall(arg1); break;

  case "install-cli":
    await cmdInstallCli(); break;

  case "agent": case "a":
    await cmdAgent(arg1 || "hq"); break;

  case "tools": case "t":
    if (arg1 === "vscode") { await cmdVsCode(); break; }
    await cmdTools(process.argv.includes("--non-interactive")); break;

  case "mcp":
    await cmdMcp(arg1); break;

  case "setup":
    await cmdSetup(); break;

  case "init":
    await cmdInit(process.argv.slice(3)); break;

  case "diagram": case "draw":
    await cmdDiagram(arg1, ...process.argv.slice(4)); break;

  case "daemon": case "d":
    await cmdDaemon(arg1, arg2); break;

  case "update":
    await cmdUpdate(process.argv.slice(3)); break;

  case "doctor":
    await cmdDoctor(); break;

  case "env":
    await cmdEnv(); break;

  case "pwa": case "web": case "dashboard":
    await cmdPwa(); break;

  case "vault":
    if (arg1 === "open") { await cmdVaultOpen(); }
    else { fail(`Unknown vault subcommand: ${arg1 ?? "(none)"}`); info("Usage: hq vault open"); }
    break;

  case "plans": case "plan":
    await cmdPlans(arg1, arg2); break;

  case "quickstart":
    await cmdQuickstart(); break;

  case "help": case "--help": case "-h":
    cmdHelp(arg1); break;

  default:
    fail(`Unknown command: ${cmd}`);
    console.log(`Run ${c.bold}hq help${c.reset} for usage.`);
    process.exit(1);
}

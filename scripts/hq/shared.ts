/**
 * Shared constants, paths, and helpers for all hq subcommands.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

// ─── Paths ────────────────────────────────────────────────────────────────────

export const REPO_ROOT = path.resolve(import.meta.dir, "../..");
export const AGENT_DIR = path.join(REPO_ROOT, "apps/discord-relay");
export const RELAY_DIR = path.join(REPO_ROOT, "apps/discord-relay");
export const HQ_DIR = path.join(REPO_ROOT, "apps/agent");
export const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");
export const LAUNCH_AGENTS = path.join(os.homedir(), "Library/LaunchAgents");

export const WA_DIR = path.join(REPO_ROOT, "apps/relay-adapter-whatsapp");
export const TG_DIR = path.join(REPO_ROOT, "apps/relay-adapter-telegram");
export const RELAY_SERVER_DIR = path.join(REPO_ROOT, "packages/agent-relay-server");
export const WA_AUTH_DIR = path.join(WA_DIR, "auth_info");

export const AGENT_DAEMON = "com.agent-hq.agent";
export const RELAY_DAEMON = "com.agent-hq.discord-relay";
export const WA_DAEMON = "com.agent-hq.whatsapp";
export const TG_DAEMON = "com.agent-hq.telegram";
export const RELAY_SERVER_DAEMON = "com.agent-hq.relay-server";

export const AGENT_LOG = path.join(os.homedir(), "Library/Logs/hq-agent.log");
export const AGENT_ERR = path.join(os.homedir(), "Library/Logs/hq-agent.error.log");
export const RELAY_LOG = path.join(os.homedir(), "Library/Logs/discord-relay.log");
export const RELAY_ERR = path.join(os.homedir(), "Library/Logs/discord-relay.error.log");
export const WA_LOG = path.join(os.homedir(), "Library/Logs/agent-hq-whatsapp.log");
export const WA_ERR = path.join(os.homedir(), "Library/Logs/agent-hq-whatsapp.error.log");
export const TG_LOG = path.join(os.homedir(), "Library/Logs/agent-hq-telegram.log");
export const TG_ERR = path.join(os.homedir(), "Library/Logs/agent-hq-telegram.error.log");
export const RELAY_SERVER_LOG = path.join(os.homedir(), "Library/Logs/agent-hq-relay-server.log");
export const RELAY_SERVER_ERR = path.join(os.homedir(), "Library/Logs/agent-hq-relay-server.error.log");
export const VAULT_SYNC_DIR = path.join(REPO_ROOT, "packages/vault-sync-server");
export const VAULT_SYNC_DAEMON = "com.agent-hq.vault-sync";
export const VAULT_SYNC_LOG = path.join(os.homedir(), "Library/Logs/agent-hq-vault-sync.log");
export const VAULT_SYNC_ERR = path.join(os.homedir(), "Library/Logs/agent-hq-vault-sync.error.log");
export const ICLOUD_BRIDGE_DAEMON = "com.agent-hq.icloud-bridge";
export const ICLOUD_BRIDGE_LOG = path.join(os.homedir(), "Library/Logs/com.agent-hq.icloud-bridge.log");
export const DAEMON_LOG = path.join(os.homedir(), "Library/Logs/hq-daemon.log");
export const DAEMON_PID = path.join(os.homedir(), "Library/Logs/hq-daemon.pid");

export const PWA_DIR = path.join(REPO_ROOT, "apps/hq-control-center");
export const PWA_DAEMON = "com.agent-hq.pwa";
export const PWA_WS_DAEMON = "com.agent-hq.pwa-ws";
export const PWA_LOG = path.join(os.homedir(), "Library/Logs/agent-hq-pwa.log");
export const PWA_ERR = path.join(os.homedir(), "Library/Logs/agent-hq-pwa.error.log");
export const PWA_WS_LOG = path.join(os.homedir(), "Library/Logs/agent-hq-pwa-ws.log");
export const PWA_WS_ERR = path.join(os.homedir(), "Library/Logs/agent-hq-pwa-ws.error.log");

export const RELAY_LOCK = path.join(RELAY_DIR, ".discord-relay/bot.lock");

// ─── ANSI colours ─────────────────────────────────────────────────────────────

export const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ─── Shell helpers ────────────────────────────────────────────────────────────

export function sh(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch { return ""; }
}

export function isAlive(pid: string): boolean {
  if (!/^\d+$/.test(pid)) return false;
  return sh(`kill -0 ${pid} 2>/dev/null; echo $?`) === "0";
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Output helpers ───────────────────────────────────────────────────────────

export const ok = (msg: string) => console.log(`${c.green}✅${c.reset}  ${msg}`);
export const fail = (msg: string) => console.log(`${c.red}❌${c.reset}  ${msg}`);
export const warn = (msg: string) => console.log(`${c.yellow}⚠️ ${c.reset}  ${msg}`);
export const info = (msg: string) => console.log(`${c.cyan}ℹ️ ${c.reset}  ${msg}`);
export const dim = (msg: string) => console.log(`${c.gray}${msg}${c.reset}`);

export function section(title: string) {
  console.log(`\n${c.bold}── ${title} ──${c.reset}`);
}

// ─── Service types ────────────────────────────────────────────────────────────

export type ServiceTarget = "agent" | "relay" | "whatsapp" | "telegram" | "relay-server" | "vault-sync" | "icloud-bridge" | "pwa" | "pwa-ws";

// ─── Daemon / process helpers ─────────────────────────────────────────────────

export function daemonPid(daemon: string): string | null {
  const line = sh(`launchctl list 2>/dev/null | grep "${daemon}"`);
  if (!line) return null;
  const pid = line.trim().split(/\s+/)[0];
  return pid && pid !== "-" && isAlive(pid) ? pid : null;
}

export function agentPid(): string | null { return daemonPid(AGENT_DAEMON); }

export function relayPid(): string | null {
  if (fs.existsSync(RELAY_LOCK)) {
    const pid = fs.readFileSync(RELAY_LOCK, "utf-8").trim();
    if (pid && isAlive(pid)) return pid;
  }
  return daemonPid(RELAY_DAEMON);
}

export function whatsappPid(): string | null { return daemonPid(WA_DAEMON); }
export function telegramPid(): string | null { return daemonPid(TG_DAEMON); }
export function relayServerPid(): string | null { return daemonPid(RELAY_SERVER_DAEMON); }
export function vaultSyncPid(): string | null { return daemonPid(VAULT_SYNC_DAEMON); }
export function icloudBridgePid(): string | null { return daemonPid(ICLOUD_BRIDGE_DAEMON); }
export function pwaPid(): string | null { return daemonPid(PWA_DAEMON); }
export function pwaWsPid(): string | null { return daemonPid(PWA_WS_DAEMON); }

export function uptime(pid: string): string {
  return sh(`ps -o etime= -p ${pid} 2>/dev/null`).trim() || "?";
}

export function resolveTargets(target?: string): ServiceTarget[] {
  if (!target || target === "all") return ["agent", "relay", "relay-server", "vault-sync", "icloud-bridge", "whatsapp", "telegram", "pwa", "pwa-ws"];
  if (target === "agent") return ["agent"];
  if (target === "relay") return ["relay"];
  if (target === "whatsapp" || target === "wa") return ["whatsapp"];
  if (target === "telegram" || target === "tg") return ["telegram"];
  if (target === "relay-server") return ["relay-server"];
  if (target === "vault-sync" || target === "vs") return ["vault-sync"];
  if (target === "icloud-bridge" || target === "ib") return ["icloud-bridge"];
  if (target === "pwa") return ["pwa"];
  if (target === "pwa-ws") return ["pwa-ws"];
  warn(`Unknown target "${target}" — expected agent, relay, whatsapp, telegram, relay-server, vault-sync, icloud-bridge, pwa, pwa-ws or all`);
  return [];
}

export function serviceInfo(t: ServiceTarget) {
  switch (t) {
    case "agent":
      return { daemon: AGENT_DAEMON, pid: agentPid, label: "HQ Agent", dir: HQ_DIR, log: AGENT_LOG, err: AGENT_ERR };
    case "relay":
      return { daemon: RELAY_DAEMON, pid: relayPid, label: "Discord Relay", dir: RELAY_DIR, log: RELAY_LOG, err: RELAY_ERR };
    case "whatsapp":
      return { daemon: WA_DAEMON, pid: whatsappPid, label: "WhatsApp", dir: WA_DIR, log: WA_LOG, err: WA_ERR };
    case "telegram":
      return { daemon: TG_DAEMON, pid: telegramPid, label: "Telegram", dir: TG_DIR, log: TG_LOG, err: TG_ERR };
    case "relay-server":
      return { daemon: RELAY_SERVER_DAEMON, pid: relayServerPid, label: "Relay Server", dir: RELAY_SERVER_DIR, log: RELAY_SERVER_LOG, err: RELAY_SERVER_ERR };
    case "vault-sync":
      return { daemon: VAULT_SYNC_DAEMON, pid: vaultSyncPid, label: "Vault Sync", dir: VAULT_SYNC_DIR, log: VAULT_SYNC_LOG, err: VAULT_SYNC_ERR };
    case "icloud-bridge":
      return { daemon: ICLOUD_BRIDGE_DAEMON, pid: icloudBridgePid, label: "iCloud Bridge", dir: SCRIPTS_DIR, log: ICLOUD_BRIDGE_LOG, err: ICLOUD_BRIDGE_LOG };
    case "pwa":
      return { daemon: PWA_DAEMON, pid: pwaPid, label: "HQ Web PWA", dir: PWA_DIR, log: PWA_LOG, err: PWA_ERR };
    case "pwa-ws":
      return { daemon: PWA_WS_DAEMON, pid: pwaWsPid, label: "HQ PWA WS", dir: PWA_DIR, log: PWA_WS_LOG, err: PWA_WS_ERR };
  }
}

export function killProcessTree(pid: string, label: string): number {
  let killed = 0;
  const children = sh(`pgrep -P ${pid} 2>/dev/null`).split("\n").filter(Boolean);
  for (const child of children) {
    killed += killProcessTree(child, `${label} child`);
  }
  if (isAlive(pid)) {
    sh(`kill -9 ${pid} 2>/dev/null`);
    info(`Killed ${label} (PID ${pid})`);
    killed++;
  }
  return killed;
}

export function findAllInstances(target: ServiceTarget): string[] {
  const svc = serviceInfo(target);
  const pids = new Set<string>();

  for (const pid of sh(`pgrep -f "${svc.dir}" 2>/dev/null`).split("\n").filter(Boolean)) {
    const cmdline = sh(`ps -o command= -p ${pid} 2>/dev/null`);
    if (cmdline && !cmdline.includes("hq.ts") && !cmdline.includes("scripts/hq")) {
      pids.add(pid);
    }
  }

  for (const line of sh(`lsof +D "${svc.dir}" -t 2>/dev/null`).split("\n").filter(Boolean)) {
    const cmdline = sh(`ps -o command= -p ${line} 2>/dev/null`);
    if (cmdline && !cmdline.includes("hq.ts") && !cmdline.includes("scripts/hq")) {
      pids.add(line);
    }
  }

  return [...pids];
}

export async function killAllInstances(target: ServiceTarget): Promise<number> {
  const svc = serviceInfo(target);
  let killed = 0;

  sh(`launchctl stop "${svc.daemon}" 2>/dev/null`);

  const primaryPid = svc.pid();
  if (primaryPid) {
    killed += killProcessTree(primaryPid, `${svc.label} (primary)`);
  }

  await sleep(300);
  const remaining = findAllInstances(target);
  for (const pid of remaining) {
    if (isAlive(pid)) {
      killed += killProcessTree(pid, `${svc.label} (stale instance)`);
    }
  }

  const entryPattern = target === "relay-server" ? `${svc.dir}/src/index.ts` : `${svc.dir}/index.ts`;
  sh(`pkill -9 -f "bun.*${entryPattern}" 2>/dev/null`);
  sh(`pkill -9 -f "node.*${entryPattern}" 2>/dev/null`);

  return killed;
}

/** Interactive y/n prompt — returns true on yes. */
export function confirmInstall(prompt: string): boolean {
  process.stdout.write(`${prompt} [y/N] `);
  const buf = Buffer.alloc(64);
  const n = fs.readSync(0, buf, 0, buf.length, null);
  return buf.toString("utf-8", 0, n).trim().toLowerCase().startsWith("y");
}

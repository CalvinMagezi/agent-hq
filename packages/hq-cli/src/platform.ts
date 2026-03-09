/**
 * Platform detection for hq CLI.
 * All OS/arch/service-manager branching goes through this module.
 */

import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";

export type OSName = "macos" | "linux" | "windows";
export type Arch = "arm64" | "x64" | "unknown";
export type ServiceManager = "launchd" | "systemd" | "taskscheduler" | "none";
export type Shell = "zsh" | "bash" | "pwsh" | "cmd" | "unknown";

export interface PlatformInfo {
  os: OSName;
  arch: Arch;
  serviceManager: ServiceManager;
  /** Directory for user-level config files */
  configDir: string;
  /** Directory where CLIs should be symlinked */
  binDir: string;
  /** User's preferred shell */
  shell: Shell;
  /** Shell rc file path (for PATH modifications) */
  shellRc: string;
  /** Whether the OS supports background services natively */
  hasDaemonSupport: boolean;
}

function detectOS(): OSName {
  switch (process.platform) {
    case "darwin": return "macos";
    case "linux":  return "linux";
    case "win32":  return "windows";
    default:       return "linux";
  }
}

function detectArch(): Arch {
  switch (process.arch) {
    case "arm64": return "arm64";
    case "x64":   return "x64";
    default:      return "unknown";
  }
}

function detectServiceManager(os: OSName): ServiceManager {
  if (os === "macos") return "launchd";
  if (os === "windows") return "taskscheduler";
  // Linux: check for systemd
  try {
    execSync("systemctl --version", { stdio: "pipe" });
    return "systemd";
  } catch {
    return "none";
  }
}

function detectShell(os: OSName): Shell {
  if (os === "windows") {
    return process.env.PSModulePath ? "pwsh" : "cmd";
  }
  const shell = process.env.SHELL ?? "";
  if (shell.includes("zsh"))  return "zsh";
  if (shell.includes("bash")) return "bash";
  return "bash";
}

function shellRcPath(shell: Shell, home: string): string {
  switch (shell) {
    case "zsh":  return path.join(home, ".zshrc");
    case "bash": return path.join(home, ".bashrc");
    case "pwsh": return path.join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
    default:     return path.join(home, ".bashrc");
  }
}

let _cached: PlatformInfo | null = null;

export function getPlatform(): PlatformInfo {
  if (_cached) return _cached;

  const home = os.homedir();
  const osName = detectOS();
  const arch = detectArch();
  const sm = detectServiceManager(osName);
  const shell = detectShell(osName);

  let configDir: string;
  let binDir: string;

  if (osName === "macos") {
    configDir = path.join(home, "Library", "Application Support", "agent-hq");
    binDir = path.join(home, ".local", "bin");
  } else if (osName === "windows") {
    configDir = path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "agent-hq");
    binDir = path.join(home, "AppData", "Local", "Microsoft", "WindowsApps");
  } else {
    configDir = path.join(home, ".config", "agent-hq");
    binDir = path.join(home, ".local", "bin");
  }

  _cached = {
    os: osName,
    arch,
    serviceManager: sm,
    configDir,
    binDir,
    shell,
    shellRc: shellRcPath(shell, home),
    hasDaemonSupport: sm !== "none",
  };

  return _cached;
}

/** Returns true if running on Windows Subsystem for Linux */
export function isWSL(): boolean {
  try {
    const release = execSync("uname -r", { stdio: "pipe", encoding: "utf-8" });
    return release.toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

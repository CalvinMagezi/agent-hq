/**
 * Dependency preflight checker + auto-installer for hq init.
 *
 * Checks for required and optional tools, attempts silent installs
 * where possible, and prints a clean summary table.
 */

import { execSync, spawnSync } from "child_process";
import type { OSName } from "./platform.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DepResult {
  name: string;
  status: "ok" | "installed" | "missing" | "skipped" | "failed";
  version?: string;
  note?: string;
}

interface DepSpec {
  name: string;
  /** Shell command to check — returns version string or empty */
  check: string;
  /** Minimum version string (semver prefix match) */
  minVersion?: string;
  required: boolean;
  autoInstall: boolean;
  install: Record<OSName, string[]>;
  skipNote?: string;
}

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
  cyan: "\x1b[36m", gray: "\x1b[90m",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sh(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch { return ""; }
}

function run(cmd: string, args: string[], cwd?: string): boolean {
  const r = spawnSync(cmd, args, { stdio: "pipe", cwd });
  return r.status === 0;
}

function semverOk(actual: string, min: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [aa, ab, ac] = parse(actual);
  const [ma, mb, mc] = parse(min);
  if (aa !== ma) return aa > ma;
  if (ab !== mb) return ab > mb;
  return (ac ?? 0) >= (mc ?? 0);
}

// ─── Dependency specs ─────────────────────────────────────────────────────────

const DEPS: DepSpec[] = [
  {
    name: "Bun",
    check: "bun --version 2>/dev/null",
    minVersion: "1.1.0",
    required: true,
    autoInstall: true,
    install: {
      macos:   ["curl -fsSL https://bun.sh/install | bash"],
      linux:   ["curl -fsSL https://bun.sh/install | bash"],
      windows: ["powershell -c \"irm bun.sh/install.ps1 | iex\""],
    },
  },
  {
    name: "Git",
    check: "git --version 2>/dev/null",
    minVersion: "2.30.0",
    required: true,
    autoInstall: true,
    install: {
      macos:   ["brew install git"],
      linux:   ["sudo apt-get install -y git || sudo dnf install -y git || sudo pacman -S git"],
      windows: ["winget install --id Git.Git -e --source winget"],
    },
  },
  {
    name: "Ollama",
    check: "ollama --version 2>/dev/null",
    required: true,
    autoInstall: true,
    install: {
      macos:   ["brew install ollama"],
      linux:   ["curl -fsSL https://ollama.com/install.sh | sh"],
      windows: ["winget install --id Ollama.Ollama -e || powershell -c \"irm https://ollama.com/install.ps1 | iex\""],
    },
  },
  {
    name: "Claude CLI",
    check: "claude --version 2>/dev/null",
    required: false,
    autoInstall: true,
    install: {
      macos:   ["npm install -g @anthropic-ai/claude-code"],
      linux:   ["npm install -g @anthropic-ai/claude-code"],
      windows: ["npm install -g @anthropic-ai/claude-code"],
    },
  },
  {
    name: "Gemini CLI",
    check: "gemini --version 2>/dev/null",
    required: false,
    autoInstall: true,
    install: {
      macos:   ["npm install -g @google/gemini-cli"],
      linux:   ["npm install -g @google/gemini-cli"],
      windows: ["npm install -g @google/gemini-cli"],
    },
  },
  {
    name: "OpenCode",
    check: "opencode --version 2>/dev/null",
    required: false,
    autoInstall: true,
    install: {
      macos:   ["npm install -g opencode-ai"],
      linux:   ["npm install -g opencode-ai"],
      windows: ["npm install -g opencode-ai"],
    },
  },
  {
    name: "gws CLI",
    check: "gws --version 2>/dev/null",
    required: false,
    autoInstall: false,
    install: { macos: [], linux: [], windows: [] },
    skipNote: "requires manual auth setup (Google Workspace)",
  },
];

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runPreflight(
  osName: OSName,
  opts: { nonInteractive?: boolean; skipOptional?: boolean } = {}
): Promise<{ results: DepResult[]; allRequiredOk: boolean }> {
  const results: DepResult[] = [];
  let allRequiredOk = true;

  console.log(`\n${c.bold}── Dependency Preflight ──${c.reset}`);

  for (const dep of DEPS) {
    if (opts.skipOptional && !dep.required) continue;

    // Check if installed
    const raw = sh(dep.check);
    const version = raw.split(/\s+/).find(s => /\d+\.\d+/.test(s)) ?? raw.split("\n")[0];

    if (raw && version) {
      // Version check
      if (dep.minVersion && !semverOk(version, dep.minVersion)) {
        printRow(dep.name, "failed", version, `need ≥ ${dep.minVersion}`);
        results.push({ name: dep.name, status: "failed", version, note: `need ≥ ${dep.minVersion}` });
        if (dep.required) allRequiredOk = false;
        continue;
      }
      printRow(dep.name, "ok", version);
      results.push({ name: dep.name, status: "ok", version });
      continue;
    }

    // Not installed
    if (dep.skipNote) {
      printRow(dep.name, "skipped", undefined, dep.skipNote);
      results.push({ name: dep.name, status: "skipped", note: dep.skipNote });
      continue;
    }

    if (!dep.autoInstall) {
      const status = dep.required ? "missing" : "skipped";
      printRow(dep.name, status);
      results.push({ name: dep.name, status });
      if (dep.required) allRequiredOk = false;
      continue;
    }

    // Auto-install
    const cmds = dep.install[osName];
    if (!cmds?.length) {
      printRow(dep.name, "missing", undefined, "no auto-install for this platform");
      results.push({ name: dep.name, status: "missing", note: "no auto-install for this platform" });
      if (dep.required) allRequiredOk = false;
      continue;
    }

    process.stdout.write(`  ${c.yellow}⟳${c.reset}  ${c.bold}${dep.name}${c.reset} — installing...`);
    let installed = false;

    for (const cmd of cmds) {
      const result = spawnSync(cmd, { shell: true, stdio: "pipe" });
      if (result.status === 0) {
        installed = true;
        break;
      }
    }

    if (installed) {
      const newVersion = sh(dep.check).split(/\s+/).find(s => /\d+\.\d+/.test(s)) ?? "installed";
      process.stdout.write(` ${c.green}done${c.reset} (${newVersion})\n`);
      results.push({ name: dep.name, status: "installed", version: newVersion });
    } else {
      process.stdout.write(` ${c.red}failed${c.reset}\n`);
      results.push({ name: dep.name, status: "failed", note: "auto-install failed — see manual install instructions" });
      if (dep.required) allRequiredOk = false;
    }
  }

  // Summary line
  const failed = results.filter(r => r.status === "failed" || (r.status === "missing" && DEPS.find(d => d.name === r.name)?.required));
  console.log();
  if (allRequiredOk) {
    console.log(`  ${c.green}✓${c.reset}  All required dependencies satisfied.\n`);
  } else {
    console.log(`  ${c.red}✗${c.reset}  ${failed.length} required dependency/dependencies failed. Fix above before continuing.\n`);
  }

  return { results, allRequiredOk };
}

/** Pull required Ollama models if not already present */
export async function ensureOllamaModels(models: string[]): Promise<void> {
  const existing = sh("ollama list 2>/dev/null");
  const toFetch = models.filter(m => !existing.includes(m.split(":")[0]));

  if (!toFetch.length) {
    console.log(`  ${c.green}✓${c.reset}  Ollama models already present.`);
    return;
  }

  for (const model of toFetch) {
    console.log(`  ${c.cyan}⟳${c.reset}  Pulling ${c.bold}${model}${c.reset} (background)...`);
    // Run pull in background — large models shouldn't block init
    const child = spawnSync("ollama", ["pull", model], { stdio: "pipe" });
    if (child.status === 0) {
      console.log(`  ${c.green}✓${c.reset}  ${model} ready`);
    } else {
      console.log(`  ${c.yellow}⚠${c.reset}  ${model} pull failed — memory features may be limited`);
    }
  }
}

function printRow(name: string, status: DepResult["status"], version?: string, note?: string) {
  const icon = status === "ok" || status === "installed"
    ? `${c.green}✓${c.reset}`
    : status === "skipped"
    ? `${c.gray}○${c.reset}`
    : status === "failed" || status === "missing"
    ? `${c.red}✗${c.reset}`
    : `${c.yellow}⟳${c.reset}`;

  const detail = version ? `${c.dim}${version}${c.reset}` : note ? `${c.gray}${note}${c.reset}` : "";
  console.log(`  ${icon}  ${c.bold}${name}${c.reset}${detail ? "  " + detail : ""}`);
}

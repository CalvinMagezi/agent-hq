/**
 * Idempotent init state tracker.
 * Reads/writes agent-hq init state in ~/.config/agent-hq/ so re-running
 * `hq init` skips steps already completed. Survives `git clean -fd`.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export type InitStep =
  | "preflight"
  | "clone"
  | "install"
  | "tools"
  | "vault"
  | "models"
  | "env"
  | "services"
  | "cli"
  | "mcp";

export interface InitState {
  version: string;
  platform: string;
  completedSteps: InitStep[];
  lastRun: string;
  warnings: string[];
}

const STATE_VERSION = "1.0.0";

/** Canonical state file path — outside repo so it survives git clean */
function resolveStatePath(repoRoot: string): string {
  const configDir = path.join(os.homedir(), ".config", "agent-hq");
  fs.mkdirSync(configDir, { recursive: true });
  // Migrate from old repo-root location if it exists
  const legacyPath = path.join(repoRoot, ".hq-init-state.json");
  const newPath = path.join(configDir, "init-state.json");
  if (fs.existsSync(legacyPath) && !fs.existsSync(newPath)) {
    try { fs.renameSync(legacyPath, newPath); } catch { /* non-fatal */ }
  }
  return newPath;
}

export class InitStateManager {
  private filePath: string;
  private state: InitState;

  constructor(repoRoot: string) {
    this.filePath = resolveStatePath(repoRoot);
    this.state = this.load();
  }

  private load(): InitState {
    if (fs.existsSync(this.filePath)) {
      try {
        return JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as InitState;
      } catch { /* fall through */ }
    }
    return {
      version: STATE_VERSION,
      platform: process.platform,
      completedSteps: [],
      lastRun: new Date().toISOString(),
      warnings: [],
    };
  }

  isDone(step: InitStep): boolean {
    return this.state.completedSteps.includes(step);
  }

  markDone(step: InitStep): void {
    if (!this.isDone(step)) {
      this.state.completedSteps.push(step);
    }
    this.state.lastRun = new Date().toISOString();
    this.save();
  }

  addWarning(msg: string): void {
    if (!this.state.warnings.includes(msg)) {
      this.state.warnings.push(msg);
    }
    this.save();
  }

  reset(): void {
    this.state = {
      version: STATE_VERSION,
      platform: process.platform,
      completedSteps: [],
      lastRun: new Date().toISOString(),
      warnings: [],
    };
    this.save();
  }

  get warnings(): string[] {
    return this.state.warnings;
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf-8");
    } catch { /* non-fatal */ }
  }
}

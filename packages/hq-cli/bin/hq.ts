#!/usr/bin/env bun
/**
 * agent-hq entry point
 *
 * When installed via `bunx agent-hq` or `npx agent-hq`:
 *   - If run from inside the monorepo, delegates to scripts/hq.ts
 *   - Otherwise, bootstraps the installation with `hq init`
 *
 * Install globally:  bunx agent-hq install-cli
 * Homebrew:          brew install calvinmagezi/agent-hq/hq
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

// ── Locate the monorepo root ──────────────────────────────────────────────────

function findRepoRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, "package.json");
    const apps = path.join(dir, "apps/agent");
    if (fs.existsSync(pkg) && fs.existsSync(apps)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// When installed via npm/bun globally, this file lives at:
//   node_modules/.bin/hq  →  node_modules/agent-hq/bin/hq.ts
// So walk up from __dirname to find the repo, or fall back to CWD.
const repoFromPackage = findRepoRoot(path.resolve(import.meta.dir, "../../.."));
const repoFromCwd = findRepoRoot(process.cwd());
const REPO_ROOT = repoFromPackage ?? repoFromCwd;

// ── Delegate or bootstrap ─────────────────────────────────────────────────────

if (REPO_ROOT) {
  // We're inside (or near) the monorepo — exec the full CLI
  const fullCli = path.join(REPO_ROOT, "scripts/hq.ts");
  if (fs.existsSync(fullCli)) {
    const result = spawnSync(process.execPath, [fullCli, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: process.env,
    });
    process.exit(result.status ?? 0);
  }
}

// ── Not in repo — run init to bootstrap ──────────────────────────────────────

console.log(`
  ┌─────────────────────────────────────────────────────┐
  │  agent-hq — first run                               │
  │                                                     │
  │  No agent-hq repository found near this location.  │
  │  Let's set everything up.                           │
  └─────────────────────────────────────────────────────┘
`);

const isNonInteractive =
  process.argv.includes("--non-interactive") ||
  process.argv.includes("-y") ||
  !process.stdout.isTTY;

const installDir = path.join(
  process.env.AGENT_HQ_DIR ?? (process.env.HOME ?? "~"),
  "agent-hq"
);

console.log(`Cloning agent-hq to: ${installDir}`);
const clone = spawnSync("git", [
  "clone", "https://github.com/CalvinMagezi/agent-hq.git", installDir
], { stdio: "inherit" });

if (clone.status !== 0) {
  console.error("\nClone failed. Check your internet connection.");
  process.exit(1);
}

const installArgs = [
  path.join(installDir, "scripts/hq.ts"),
  "init",
  ...(isNonInteractive ? ["--non-interactive"] : []),
];
const init = spawnSync(process.execPath, installArgs, {
  cwd: installDir,
  stdio: "inherit",
  env: process.env,
});
process.exit(init.status ?? 0);

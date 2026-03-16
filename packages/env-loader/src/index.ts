/**
 * @repo/env-loader — Shared environment variable loader for the Agent-HQ monorepo.
 *
 * Loads env files in precedence order (first value wins, shell env always takes priority):
 *   1. App-local .env.local  (CWD/.env.local)
 *   2. Root .env.local        (monorepo root/.env.local)
 *   3. App-local .env         (CWD/.env)
 *   4. Root .env              (monorepo root/.env)
 *
 * Usage — add this as the FIRST import in every entry point:
 *
 *   import "@repo/env-loader";
 *
 * Or call loadMonorepoEnv() explicitly if you need to pass options.
 */

import { config as dotenvConfig } from "dotenv";
import { existsSync } from "fs";
import { resolve, join, dirname } from "path";

/** Find the monorepo root by walking up from a starting dir until we find a package.json with "workspaces". */
function findMonorepoRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(require("fs").readFileSync(pkgPath, "utf-8"));
        if (pkg.workspaces) return dir;
      } catch { /* ignore parse errors */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

export interface LoadEnvOptions {
  /** Override the app directory (default: process.cwd()) */
  appDir?: string;
  /** Override the monorepo root (default: auto-detected) */
  rootDir?: string;
  /** Print debug info about which files were loaded */
  debug?: boolean;
}

let _loaded = false;

/**
 * Load environment variables from both the app-local and monorepo-root .env files.
 * Safe to call multiple times — only the first call has effect.
 */
export function loadMonorepoEnv(options?: LoadEnvOptions): void {
  if (_loaded) return;
  _loaded = true;

  const appDir = resolve(options?.appDir ?? process.cwd());
  const rootDir = options?.rootDir
    ? resolve(options.rootDir)
    : findMonorepoRoot(appDir);
  const debug = options?.debug ?? false;

  // Load order: app-local first (highest precedence), then root (fills gaps).
  // dotenv does NOT override vars already set in process.env or by a prior dotenv call.
  const files = [
    join(appDir, ".env.local"),
    ...(rootDir && rootDir !== appDir ? [join(rootDir, ".env.local")] : []),
    join(appDir, ".env"),
    ...(rootDir && rootDir !== appDir ? [join(rootDir, ".env")] : []),
  ];

  for (const file of files) {
    if (existsSync(file)) {
      dotenvConfig({ path: file });
      if (debug) console.log(`[env-loader] Loaded: ${file}`);
    } else {
      if (debug) console.log(`[env-loader] Not found: ${file}`);
    }
  }
}

// Auto-load on import (side-effect import pattern: `import "@repo/env-loader"`)
loadMonorepoEnv();

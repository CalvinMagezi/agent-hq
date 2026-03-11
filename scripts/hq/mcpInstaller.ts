/**
 * hq mcp — Auto-Install HQ MCP Server Across All AI Agents
 * 
 * Logic for detecting, configuring, and removing the HQ MCP server
 * from various AI agent configuration files.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { 
  ok, fail, warn, info, dim, section, c, sh, REPO_ROOT 
} from "./shared.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface McpContext {
  repoRoot: string;
  vaultPath: string;
  mcpScript: string;      // Absolute path to mcp.ts
  openrouterApiKey: string;
  securityProfile: string;
}

export interface AgentTarget {
  name: string;
  slug: string;
  configPath: string;
  mcpField: string;       // e.g. "mcpServers"
  serverKey: string;      // e.g. "agent-hq"
  exists(): boolean;
  buildEntry(ctx: McpContext): any;
  isCorrect(existing: any, ctx: McpContext): boolean;
  restartReminder?: string;
}

// ─── Credential Resolution ─────────────────────────────────────────────────────

export function resolveCredentials(repoRoot: string): { openrouterApiKey: string } {
  const envFiles = [
    path.join(repoRoot, "apps/agent/.env.local"),
    path.join(repoRoot, ".env.local"),
    path.join(repoRoot, "apps/discord-relay/.env.local"),
  ];

  let apiKey = process.env.OPENROUTER_API_KEY || "";

  if (!apiKey) {
    for (const file of envFiles) {
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, "utf-8");
        const match = content.match(/^OPENROUTER_API_KEY\s*=\s*(.*)$/m);
        if (match) {
          apiKey = match[1].trim().replace(/^["']|["']$/g, "");
          if (apiKey) {
            ok(`OPENROUTER_API_KEY resolved from ${path.relative(repoRoot, file)}`);
            break;
          }
        }
      }
    }
  }

  if (!apiKey) {
    warn("OPENROUTER_API_KEY not found in environment or .env.local files.");
    info("The MCP server will still work for local vault access, but web search will be disabled.");
  }

  return { openrouterApiKey: apiKey };
}

// ─── JSON Helpers ──────────────────────────────────────────────────────────────

function readJsonSafe(filePath: string): any {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    warn(`Malformed JSON in ${filePath} — skipping to avoid data loss.`);
    return null;
  }
}

function writeJsonSafe(filePath: string, data: any): boolean {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch (err) {
    fail(`Failed to write config ${filePath}: ${err}`);
    return false;
  }
}

// ─── Agent Registry ────────────────────────────────────────────────────────────

export function getAgentTargets(repoRoot: string): AgentTarget[] {
  const vaultPath = process.env.VAULT_PATH || path.join(repoRoot, ".vault");
  const mcpScript = path.join(repoRoot, "packages/hq-tools/src/mcp.ts");

  const standardIsCorrect = (existing: any, ctx: McpContext) => {
    if (!existing || typeof existing !== "object") return false;
    const sameCommand = existing.command === "bun";
    const sameScript = Array.isArray(existing.args) && existing.args.includes(ctx.mcpScript);
    const sameVault = existing.env?.VAULT_PATH === ctx.vaultPath;
    const sameKey = existing.env?.OPENROUTER_API_KEY === ctx.openrouterApiKey;
    return sameCommand && sameScript && sameVault && sameKey;
  };

  const standardBuildEntry = (ctx: McpContext) => ({
    command: "bun",
    args: ["run", ctx.mcpScript],
    env: {
      VAULT_PATH: ctx.vaultPath,
      OPENROUTER_API_KEY: ctx.openrouterApiKey,
      SECURITY_PROFILE: ctx.securityProfile
    }
  });

  return [
    {
      name: "Claude Code (global)",
      slug: "claude-code-global",
      configPath: path.join(os.homedir(), ".claude.json"),
      mcpField: "mcpServers",
      serverKey: "agent-hq",
      exists: () => true, // Global config can always be created
      buildEntry: standardBuildEntry,
      isCorrect: standardIsCorrect,
    },
    {
      name: "Claude Code (project)",
      slug: "claude-code-project",
      configPath: path.join(repoRoot, ".mcp.json"),
      mcpField: "mcpServers",
      serverKey: "agent-hq",
      exists: () => true,
      buildEntry: standardBuildEntry,
      isCorrect: standardIsCorrect,
    },
    {
      name: "Claude Desktop",
      slug: "claude-desktop",
      configPath: path.join(os.homedir(), "Library/Application Support/Claude/claude_desktop_config.json"),
      mcpField: "mcpServers",
      serverKey: "agent-hq",
      exists: () => fs.existsSync(path.join(os.homedir(), "Library/Application Support/Claude")),
      buildEntry: standardBuildEntry,
      isCorrect: standardIsCorrect,
      restartReminder: "Restart Claude Desktop to activate changes.",
    },
    {
      name: "OpenCode",
      slug: "opencode",
      configPath: path.join(os.homedir(), ".config/opencode/config.json"),
      mcpField: "mcp",
      serverKey: "agent-hq",
      exists: () => fs.existsSync(path.join(os.homedir(), ".config/opencode")) || sh("opencode --version") !== "",
      buildEntry: (ctx) => ({
        type: "local",
        command: ["bun", "run", ctx.mcpScript],
        args: [],
        env: {
          VAULT_PATH: ctx.vaultPath,
          OPENROUTER_API_KEY: ctx.openrouterApiKey,
          SECURITY_PROFILE: ctx.securityProfile
        },
        enabled: true
      }),
      isCorrect: (existing, ctx) => {
        if (!existing || existing.type !== "local") return false;
        const sameCommand = Array.isArray(existing.command) && existing.command.includes(ctx.mcpScript);
        const sameVault = existing.env?.VAULT_PATH === ctx.vaultPath;
        const sameKey = existing.env?.OPENROUTER_API_KEY === ctx.openrouterApiKey;
        return sameCommand && sameVault && sameKey && existing.enabled === true;
      }
    },
    {
      name: "Gemini CLI",
      slug: "gemini-cli",
      configPath: path.join(os.homedir(), ".gemini/settings.json"),
      mcpField: "mcpServers",
      serverKey: "agent-hq",
      exists: () => fs.existsSync(path.join(os.homedir(), ".gemini")),
      buildEntry: (ctx) => ({
        ...standardBuildEntry(ctx),
        trust: true
      }),
      isCorrect: (existing, ctx) => standardIsCorrect(existing, ctx) && existing.trust === true,
    },
    {
      name: "Cursor",
      slug: "cursor",
      configPath: path.join(os.homedir(), ".cursor/mcp.json"),
      mcpField: "mcpServers",
      serverKey: "agent-hq",
      exists: () => fs.existsSync(path.join(os.homedir(), ".cursor")),
      buildEntry: standardBuildEntry,
      isCorrect: standardIsCorrect,
    },
    {
      name: "Windsurf",
      slug: "windsurf",
      configPath: fs.existsSync(path.join(os.homedir(), ".codeium/windsurf/mcp_config.json")) 
        ? path.join(os.homedir(), ".codeium/windsurf/mcp_config.json")
        : path.join(os.homedir(), ".windsurf/mcp.json"),
      mcpField: "mcpServers",
      serverKey: "agent-hq",
      exists: () => fs.existsSync(path.join(os.homedir(), ".codeium/windsurf")) || fs.existsSync(path.join(os.homedir(), ".windsurf")),
      buildEntry: standardBuildEntry,
      isCorrect: standardIsCorrect,
    }
  ];
}

// ─── Public API ────────────────────────────────────────────────────────────────

export async function mcpStatus(repoRoot: string): Promise<void> {
  section("HQ MCP Installation Status");
  const ctx = getContext(repoRoot);
  const targets = getAgentTargets(repoRoot);

  for (const t of targets) {
    if (!t.exists()) {
      console.log(`  ${t.name.padEnd(24)} ${c.gray}─  not installed${c.reset}`);
      continue;
    }

    const config = readJsonSafe(t.configPath);
    if (!config) {
      console.log(`  ${t.name.padEnd(24)} ${c.yellow}⚠️  malformed config${c.reset}`);
      continue;
    }

    const entry = config[t.mcpField]?.[t.serverKey];
    const paddedName = t.name.padEnd(24);
    const shortPath = t.configPath.replace(os.homedir(), "~");

    if (!entry) {
      console.log(`  ${paddedName} ${c.red}❌ not configured${c.reset}`);
    } else if (t.isCorrect(entry, ctx)) {
      console.log(`  ${paddedName} ${c.green}✅ installed${c.reset}       ${c.gray}${shortPath}${c.reset}`);
    } else {
      console.log(`  ${paddedName} ${c.yellow}⚠️  outdated${c.reset}        ${c.gray}${shortPath}${c.reset}`);
    }
  }
  console.log();
}

export async function mcpInstall(repoRoot: string, nonInteractive: boolean): Promise<void> {
  section("HQ MCP Server Installation");
  const ctx = getContext(repoRoot);
  const targets = getAgentTargets(repoRoot);
  let configured = 0;
  let upToDate = 0;
  let notFound = 0;
  const reminders = new Set<string>();

  for (const t of targets) {
    if (!t.exists()) {
      notFound++;
      continue;
    }

    const config = readJsonSafe(t.configPath) || {};
    config[t.mcpField] ??= {};

    // Migration: vault -> agent-hq
    if (!config[t.mcpField][t.serverKey] && config[t.mcpField]["vault"]) {
      const oldEntry = config[t.mcpField]["vault"];
      const isLegacyHq = Array.isArray(oldEntry.args) && oldEntry.args.some((a: string) => a.includes("hq-tools/src/mcp.ts"));
      if (isLegacyHq) {
        config[t.mcpField][t.serverKey] = config[t.mcpField]["vault"];
        delete config[t.mcpField]["vault"];
        dim(`  ${t.name.padEnd(24)} migrated vault → agent-hq`);
      }
    }

    const existing = config[t.mcpField][t.serverKey];
    const label = t.name.padEnd(24);

    if (existing && t.isCorrect(existing, ctx)) {
      console.log(`  ${label} ${c.gray}already correct (skipped)${c.reset}`);
      upToDate++;
      continue;
    }

    const statusMsg = existing ? "updated" : "installed";
    config[t.mcpField][t.serverKey] = t.buildEntry(ctx);

    if (writeJsonSafe(t.configPath, config)) {
      ok(`${label} ${statusMsg}`);
      configured++;
      if (t.restartReminder) reminders.add(t.restartReminder);
    }
  }

  console.log();
  for (const r of reminders) info(r);
  
  ok(`Done — ${configured} agents configured, ${upToDate} up-to-date, ${notFound} agents not found.`);
}

export async function mcpRemove(repoRoot: string): Promise<void> {
  section("Removing HQ MCP Server");
  const targets = getAgentTargets(repoRoot);
  let removed = 0;

  for (const t of targets) {
    if (!t.exists()) continue;

    const config = readJsonSafe(t.configPath);
    if (!config || !config[t.mcpField]) continue;

    if (config[t.mcpField][t.serverKey]) {
      delete config[t.mcpField][t.serverKey];
      if (writeJsonSafe(t.configPath, config)) {
        ok(`${t.name.padEnd(24)} removed`);
        removed++;
      }
    }
  }

  ok(`Done — removed from ${removed} agents.`);
}

// ─── Internal Helpers ──────────────────────────────────────────────────────────

function getContext(repoRoot: string): McpContext {
  const { openrouterApiKey } = resolveCredentials(repoRoot);
  return {
    repoRoot,
    vaultPath: process.env.VAULT_PATH || path.join(repoRoot, ".vault"),
    mcpScript: path.join(repoRoot, "packages/hq-tools/src/mcp.ts"),
    openrouterApiKey,
    securityProfile: "standard"
  };
}

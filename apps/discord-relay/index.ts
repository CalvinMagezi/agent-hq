import "@repo/env-loader";
import { join } from "path";
import { acquireLock, releaseLock } from "./src/lock.js";
import { buildConfig, BotInstance } from "./src/bot.js";

// Prevent unhandled errors from crashing the relay process
process.on("unhandledRejection", (reason: any) => {
  console.error("[Relay] Unhandled rejection (process kept alive):", reason?.message || reason);
});
process.on("uncaughtException", (err: Error) => {
  console.error("[Relay] Uncaught exception (process kept alive):", err.message);
});

// Validate: user ID is always required
if (!process.env.DISCORD_USER_ID) {
  console.error("Missing required env var: DISCORD_USER_ID");
  process.exit(1);
}

// At least one bot token must be configured
const hasAnyBot =
  process.env.DISCORD_BOT_TOKEN ||
  process.env.DISCORD_BOT_TOKEN_OPENCODE ||
  process.env.DISCORD_BOT_TOKEN_GEMINI ||
  process.env.DISCORD_BOT_TOKEN_CODEX;

if (!hasAnyBot) {
  console.error(
    "No bot tokens configured. Set at least one of: DISCORD_BOT_TOKEN, DISCORD_BOT_TOKEN_OPENCODE, DISCORD_BOT_TOKEN_GEMINI, DISCORD_BOT_TOKEN_CODEX",
  );
  process.exit(1);
}

// Use the first available relay dir for the process lock
const RELAY_DIR =
  process.env.RELAY_DIR ||
  (process.env.DISCORD_BOT_TOKEN
    ? ".discord-relay"
    : process.env.DISCORD_BOT_TOKEN_OPENCODE
      ? process.env.RELAY_DIR_OPENCODE || ".discord-relay-opencode"
      : process.env.DISCORD_BOT_TOKEN_GEMINI
        ? process.env.RELAY_DIR_GEMINI || ".discord-relay-gemini"
        : process.env.RELAY_DIR_CODEX || ".discord-relay-codex");

if (!(await acquireLock(RELAY_DIR))) {
  console.error("Another discord-relay instance is already running. Exiting.");
  process.exit(1);
}

const sharedConfig = buildConfig();
const vaultPath = sharedConfig.vaultPath || ".vault";
const bots: BotInstance[] = [];

// ── Shared VaultSync instance — one watcher + one SQLite writer for all bots ──
// Passing it to each BotInstance prevents multiple fs.watch + SQLITE_BUSY issues.
let sharedSync: any = null;
if (sharedConfig.vaultPath) {
  try {
    const { VaultSync } = await import("@repo/vault-sync");
    sharedSync = new VaultSync({
      vaultPath: sharedConfig.vaultPath,
      debounceMs: 200,
      stabilityMs: 500,
      fullScanIntervalMs: 3_600_000,
    });
    await sharedSync.start();
    console.log("[Relay] Shared sync engine started.");
  } catch (err: any) {
    console.warn("[Relay] Shared sync engine failed, bots will use polling:", err.message);
  }
}

// ── Bot Instances ────────────────────────────────────────────────────────
// Each bot is a separate Discord application (token), but all share the same
// unified architecture with full harness switching. The defaultHarness is just
// the starting point — users can switch freely via /harness or !harness.
//
// Custom instructions can be loaded from vault MD files to give each bot
// a distinct personality/focus (e.g., one for dev work, one for workspace tasks).

// Claude Code Bot (optional — set DISCORD_BOT_TOKEN to enable)
if (process.env.DISCORD_BOT_TOKEN) {
  bots.push(new BotInstance({
    relayConfig: sharedConfig,
    defaultHarness: "hq",
    customInstructionsPath: process.env.CLAUDE_BOT_INSTRUCTIONS
      || join(vaultPath, "_system/agents/claude-bot.md"),
  }, sharedSync));
  console.log("[HQ Agent] Bot enabled — token configured.");
}

// OpenCode Bot (optional — set DISCORD_BOT_TOKEN_OPENCODE to enable)
if (process.env.DISCORD_BOT_TOKEN_OPENCODE) {
  const relayDir = process.env.RELAY_DIR_OPENCODE || ".discord-relay-opencode";
  bots.push(new BotInstance({
    relayConfig: {
      ...sharedConfig,
      discordBotToken: process.env.DISCORD_BOT_TOKEN_OPENCODE,
      discordBotId: process.env.DISCORD_BOT_ID_OPENCODE,
      relayDir,
      uploadsDir: `${relayDir}/uploads`,
    },
    defaultHarness: "opencode",
    customInstructionsPath: process.env.OPENCODE_BOT_INSTRUCTIONS
      || join(vaultPath, "_system/agents/opencode-bot.md"),
  }, sharedSync));
  console.log("[OpenCode] Bot enabled — token configured.");
}

// Gemini CLI Bot (optional — set DISCORD_BOT_TOKEN_GEMINI to enable)
if (process.env.DISCORD_BOT_TOKEN_GEMINI) {
  const relayDir = process.env.RELAY_DIR_GEMINI || ".discord-relay-gemini";
  bots.push(new BotInstance({
    relayConfig: {
      ...sharedConfig,
      discordBotToken: process.env.DISCORD_BOT_TOKEN_GEMINI,
      discordBotId: process.env.DISCORD_BOT_ID_GEMINI,
      relayDir,
      uploadsDir: `${relayDir}/uploads`,
    },
    defaultHarness: "gemini-cli",
    customInstructionsPath: process.env.GEMINI_BOT_INSTRUCTIONS
      || join(vaultPath, "_system/agents/gemini-bot.md"),
  }, sharedSync));
  console.log("[Gemini CLI] Bot enabled — token configured.");
}

// Codex CLI Bot (optional — set DISCORD_BOT_TOKEN_CODEX to enable)
if (process.env.DISCORD_BOT_TOKEN_CODEX) {
  const relayDir = process.env.RELAY_DIR_CODEX || ".discord-relay-codex";
  bots.push(new BotInstance({
    relayConfig: {
      ...sharedConfig,
      discordBotToken: process.env.DISCORD_BOT_TOKEN_CODEX,
      discordBotId: process.env.DISCORD_BOT_ID_CODEX,
      relayDir,
      uploadsDir: `${relayDir}/uploads`,
    },
    defaultHarness: "codex-cli",
    customInstructionsPath: process.env.CODEX_BOT_INSTRUCTIONS
      || join(vaultPath, "_system/agents/codex-bot.md"),
  }, sharedSync));
  console.log("[Codex CLI] Bot enabled — token configured.");
}

// Graceful shutdown
const shutdown = async () => {
  console.log("\nShutting down all bots...");
  await Promise.all(bots.map((b) => b.stop()));
  await releaseLock(RELAY_DIR);
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start
const enabledBots: string[] = [];
if (process.env.DISCORD_BOT_TOKEN) enabledBots.push("Claude Code");
if (process.env.DISCORD_BOT_TOKEN_OPENCODE) enabledBots.push("OpenCode");
if (process.env.DISCORD_BOT_TOKEN_GEMINI) enabledBots.push("Gemini");
if (process.env.DISCORD_BOT_TOKEN_CODEX) enabledBots.push("Codex");

console.log(`
+----------------------------------------------+
|  Discord Multi-Bot Relay (Unified)           |
|  Bots: ${bots.length} (${enabledBots.join(" + ")})
|  User: ${process.env.DISCORD_USER_ID}
|  Vault: ${vaultPath}
|  Status: Starting...                         |
+----------------------------------------------+
`);

await Promise.all(bots.map((b) => b.start()));

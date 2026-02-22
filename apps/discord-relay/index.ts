import dotenv from "dotenv";
import { acquireLock, releaseLock } from "./src/lock.js";
import { buildConfig, BotInstance } from "./src/bot.js";
import { ClaudeHarness } from "./src/claude.js";
import { OpenCodeHarness } from "./src/harnesses/opencode.js";
import { GeminiHarness } from "./src/harnesses/gemini.js";

dotenv.config({ path: ".env.local" });

// Validate: user ID is always required
if (!process.env.DISCORD_USER_ID) {
  console.error("Missing required env var: DISCORD_USER_ID");
  process.exit(1);
}

// At least one bot token must be configured
const hasAnyBot =
  process.env.DISCORD_BOT_TOKEN ||
  process.env.DISCORD_BOT_TOKEN_OPENCODE ||
  process.env.DISCORD_BOT_TOKEN_GEMINI;

if (!hasAnyBot) {
  console.error(
    "No bot tokens configured. Set at least one of: DISCORD_BOT_TOKEN, DISCORD_BOT_TOKEN_OPENCODE, DISCORD_BOT_TOKEN_GEMINI",
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
      : process.env.RELAY_DIR_GEMINI || ".discord-relay-gemini");

if (!(await acquireLock(RELAY_DIR))) {
  console.error("Another discord-relay instance is already running. Exiting.");
  process.exit(1);
}

const sharedConfig = buildConfig();
const bots: BotInstance[] = [];

// ── Claude Code Bot (optional — set DISCORD_BOT_TOKEN to enable) ────
if (process.env.DISCORD_BOT_TOKEN) {
  const claudeHarness = new ClaudeHarness(sharedConfig);
  bots.push(new BotInstance(sharedConfig, claudeHarness));
  console.log("[Claude Code] Bot enabled — token configured.");
}

// ── OpenCode Bot (optional — set DISCORD_BOT_TOKEN_OPENCODE to enable) ─
if (process.env.DISCORD_BOT_TOKEN_OPENCODE) {
  const opencodeConfig = {
    ...sharedConfig,
    discordBotToken: process.env.DISCORD_BOT_TOKEN_OPENCODE,
    discordBotId: process.env.DISCORD_BOT_ID_OPENCODE,
    relayDir: process.env.RELAY_DIR_OPENCODE || ".discord-relay-opencode",
    uploadsDir: `${process.env.RELAY_DIR_OPENCODE || ".discord-relay-opencode"}/uploads`,
  };
  const opencodeHarness = new OpenCodeHarness({
    opencodePath: process.env.OPENCODE_PATH || "opencode",
    projectDir: process.env.PROJECT_DIR || process.cwd(),
    relayDir: opencodeConfig.relayDir,
  });
  bots.push(new BotInstance(opencodeConfig, opencodeHarness));
  console.log("[OpenCode] Bot enabled — token configured.");
}

// ── Gemini CLI Bot (optional — set DISCORD_BOT_TOKEN_GEMINI to enable) ──
if (process.env.DISCORD_BOT_TOKEN_GEMINI) {
  const geminiRelayDir = process.env.RELAY_DIR_GEMINI || ".discord-relay-gemini";
  const geminiConfig = {
    ...sharedConfig,
    discordBotToken: process.env.DISCORD_BOT_TOKEN_GEMINI,
    discordBotId: process.env.DISCORD_BOT_ID_GEMINI,
    relayDir: geminiRelayDir,
    uploadsDir: `${geminiRelayDir}/uploads`,
  };
  const geminiHarness = new GeminiHarness({
    geminiPath: process.env.GEMINI_PATH || "gemini",
    projectDir: process.env.PROJECT_DIR || process.cwd(),
    relayDir: geminiRelayDir,
    defaultModel: process.env.GEMINI_DEFAULT_MODEL,
  });
  bots.push(new BotInstance(geminiConfig, geminiHarness));
  console.log("[Gemini CLI] Bot enabled — token configured.");
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

console.log(`
+----------------------------------------------+
|  Discord Multi-Bot Relay                     |
|  Bots: ${bots.length} (${enabledBots.join(" + ")})
|  User: ${process.env.DISCORD_USER_ID}
|  Vault: ${process.env.VAULT_PATH || ".vault"}
|  Status: Starting...                         |
+----------------------------------------------+
`);

await Promise.all(bots.map((b) => b.start()));

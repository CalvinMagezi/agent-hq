/**
 * Relay Discord Adapter — entry point.
 *
 * Thin Discord bot that routes all messages through the agent relay server.
 * Coexists with the existing discord-relay; can run either/both.
 *
 * Required env vars:
 *   DISCORD_BOT_TOKEN_RELAY  Discord bot token for the relay adapter bot
 *   DISCORD_USER_ID          Your Discord user ID (messages from this user only)
 *
 * Optional:
 *   RELAY_HOST               Relay server host (default: 127.0.0.1)
 *   RELAY_PORT               Relay server port (default: 18900)
 *   AGENTHQ_API_KEY          API key for relay server authentication
 */

import { config as loadEnv } from "dotenv";
import { RelayDiscordBot } from "./bot.js";

// Load .env.local first, then .env
loadEnv({ path: ".env.local" });
loadEnv();

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN_RELAY ?? process.env.DISCORD_BOT_TOKEN;
const DISCORD_USER_ID = process.env.DISCORD_USER_ID;

if (!DISCORD_BOT_TOKEN) {
  console.error(
    "Error: DISCORD_BOT_TOKEN_RELAY (or DISCORD_BOT_TOKEN) is required.\n" +
    "Set it in apps/relay-adapter-discord/.env.local",
  );
  process.exit(1);
}

if (!DISCORD_USER_ID) {
  console.error(
    "Error: DISCORD_USER_ID is required.\n" +
    "Set it in apps/relay-adapter-discord/.env.local",
  );
  process.exit(1);
}

const bot = new RelayDiscordBot({
  discordBotToken: DISCORD_BOT_TOKEN,
  discordUserId: DISCORD_USER_ID,
  relayHost: process.env.RELAY_HOST,
  relayPort: process.env.RELAY_PORT ? parseInt(process.env.RELAY_PORT, 10) : undefined,
  apiKey: process.env.AGENTHQ_API_KEY,
  debug: process.env.DEBUG === "true" || process.env.DEBUG === "1",
});

bot.start().catch((err) => {
  console.error("[relay-discord] Failed to start:", err);
  process.exit(1);
});

process.on("SIGINT", async () => {
  console.log("\n[relay-discord] Shutting down...");
  await bot.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await bot.stop();
  process.exit(0);
});

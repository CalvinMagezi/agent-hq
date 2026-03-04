/**
 * Relay Telegram Adapter — entry point.
 *
 * Connects a Telegram bot (via grammY) to the HQ agent relay server.
 * Uses long polling — no webhook/SSL needed for local-first setup.
 *
 * SECURITY: Only the configured TELEGRAM_USER_ID can interact with the bot.
 * All other users are silently ignored. This is immutable.
 *
 * Supports: text, photos (AI vision), videos, documents, stickers,
 * voice notes (transcription + TTS), locations, contacts, polls,
 * inline keyboards for harness selection, HTML formatting.
 *
 * Required env vars:
 *   TELEGRAM_BOT_TOKEN    Bot token from @BotFather
 *   TELEGRAM_USER_ID      Your numeric Telegram user ID
 *
 * Optional:
 *   RELAY_HOST            Relay server host (default: 127.0.0.1)
 *   RELAY_PORT            Relay server port (default: 18900)
 *   AGENTHQ_API_KEY       API key for relay server authentication
 *   DEBUG                 Enable debug logging (true/1)
 *   GROQ_API_KEY          Enables voice note transcription
 *   OPENAI_API_KEY        Enables TTS voice replies
 *   VOICE_TTS_VOICE       TTS voice preset (default: alloy)
 *   OPENROUTER_API_KEY    Enables AI vision for received images
 *   VISION_MODEL          Vision model ID
 *   MEDIA_AUTO_PROCESS    Auto-process received media (default: true)
 */

import { config as loadEnv } from "dotenv";
import path from "node:path";
import { TelegramGuard } from "./guard.js";
import { TelegramBridge } from "./telegram.js";
import { RelayTelegramBot } from "./bot.js";
import { VoiceHandler } from "./voice.js";
import { MediaHandler } from "./media.js";

// Load env: local .env.local first, then root .env.local, then .env
// This lets the root .env.local hold shared keys (API keys, bot token, etc.)
const rootDir = path.resolve(import.meta.dir, "../../..");
loadEnv({ path: ".env.local" });
loadEnv({ path: path.join(rootDir, ".env.local") });
loadEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const USER_ID = process.env.TELEGRAM_USER_ID;

if (!BOT_TOKEN) {
  console.error(
    "Error: TELEGRAM_BOT_TOKEN is required.\n" +
      "Get one from @BotFather on Telegram:\n" +
      "  1. Open Telegram and message @BotFather\n" +
      "  2. Send /newbot and follow the prompts\n" +
      "  3. Copy the token to .env.local",
  );
  process.exit(1);
}

if (!USER_ID) {
  console.error(
    "Error: TELEGRAM_USER_ID is required.\n" +
      "Find your numeric user ID:\n" +
      "  1. Open Telegram and message @userinfobot\n" +
      "  2. Send /start\n" +
      "  3. Copy the 'Id' number to .env.local",
  );
  process.exit(1);
}

// Create immutable security guard
let guard: TelegramGuard;
try {
  guard = new TelegramGuard(USER_ID);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║  Telegram Relay Adapter for Agent-HQ                   ║");
console.log("╠══════════════════════════════════════════════════════════╣");
console.log(`║  SECURITY: Locked to owner only                        ║`);
console.log(`║  Owner ID: ${String(guard.ownerUserId).padEnd(44)}║`);
console.log(`║  All other users are INVISIBLE to the agent            ║`);
console.log("╚══════════════════════════════════════════════════════════╝");

// Voice note support (optional)
const groqApiKey = process.env.GROQ_API_KEY;
const openaiApiKey = process.env.OPENAI_API_KEY;

const voiceHandler = groqApiKey
  ? new VoiceHandler({
      transcriptionApiKey: groqApiKey,
      ttsApiKey: openaiApiKey,
      ttsVoice: process.env.VOICE_TTS_VOICE ?? "alloy",
    })
  : undefined;

if (voiceHandler) {
  const ttsStatus = openaiApiKey
    ? "enabled"
    : "disabled (set OPENAI_API_KEY to enable !voice on)";
  console.log("[telegram] Voice transcription enabled (Groq whisper-large-v3-turbo)");
  console.log(`[telegram] Voice replies: ${ttsStatus}`);
} else {
  console.log("[telegram] Voice support disabled — set GROQ_API_KEY to enable transcription");
}

// Media handler (optional but recommended)
const openRouterApiKey = process.env.OPENROUTER_API_KEY;
const visionModel = process.env.VISION_MODEL;
const mediaAutoProcess =
  process.env.MEDIA_AUTO_PROCESS !== "false" &&
  process.env.MEDIA_AUTO_PROCESS !== "0";

const mediaHandler = new MediaHandler({
  openRouterApiKey,
  visionModel,
});

if (openRouterApiKey) {
  console.log(
    `[telegram] AI vision enabled (model: ${visionModel ?? "google/gemini-2.5-flash-preview-05-20"})`,
  );
} else {
  console.log("[telegram] AI vision disabled — set OPENROUTER_API_KEY to enable image descriptions");
}
console.log(`[telegram] Media auto-processing: ${mediaAutoProcess ? "on" : "off"}`);

// Create bridge and bot
const isDebug = process.env.DEBUG === "true" || process.env.DEBUG === "1";

const bridge = new TelegramBridge({
  guard,
  token: BOT_TOKEN,
  debug: isDebug,
});

const bot = new RelayTelegramBot({
  guard,
  bridge,
  relayHost: process.env.RELAY_HOST,
  relayPort: process.env.RELAY_PORT ? parseInt(process.env.RELAY_PORT, 10) : undefined,
  apiKey: process.env.AGENTHQ_API_KEY,
  debug: isDebug,
  voiceHandler,
  mediaHandler,
  mediaAutoProcess,
});

bot.start().catch((err) => {
  console.error("[relay-telegram] Failed to start:", err);
  process.exit(1);
});

process.on("SIGINT", async () => {
  console.log("\n[relay-telegram] Shutting down...");
  await bot.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await bot.stop();
  process.exit(0);
});

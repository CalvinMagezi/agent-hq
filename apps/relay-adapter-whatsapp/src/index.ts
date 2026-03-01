/**
 * Relay WhatsApp Adapter — entry point.
 *
 * Native WhatsApp relay that connects the user's self-chat to the
 * HQ agent via the relay server. Uses Baileys for WhatsApp Web
 * multidevice protocol.
 *
 * SECURITY: Only the owner's self-chat is accessible. All other
 * conversations are invisible to the agent. This is immutable.
 *
 * Supports: text, images (AI vision), videos, documents, stickers,
 * voice notes (transcription + TTS), locations, contacts, polls,
 * reactions, forwarding, editing, deletion, WhatsApp-native formatting.
 *
 * Required env vars:
 *   WHATSAPP_OWNER_JID   Your WhatsApp JID (e.g., 256XXXXXXXXX@s.whatsapp.net)
 *
 * Optional:
 *   RELAY_HOST            Relay server host (default: 127.0.0.1)
 *   RELAY_PORT            Relay server port (default: 18900)
 *   AGENTHQ_API_KEY       API key for relay server authentication
 *   DEBUG                 Enable debug logging (true/1)
 *   GROQ_API_KEY          Enables voice note transcription (Groq whisper-large-v3-turbo)
 *   OPENAI_API_KEY        Enables TTS voice replies (optional, requires GROQ_API_KEY too)
 *   VOICE_TTS_VOICE       TTS voice preset (default: alloy)
 *   OPENROUTER_API_KEY    Enables AI vision for received images
 *   VISION_MODEL          Vision model ID (default: google/gemini-2.5-flash-preview-05-20)
 *   MEDIA_AUTO_PROCESS    Auto-process received media with AI (default: true)
 */

import { config as loadEnv } from "dotenv";
import { WhatsAppGuard } from "./guard.js";
import { WhatsAppBridge } from "./whatsapp.js";
import { RelayWhatsAppBot } from "./bot.js";
import { VoiceHandler } from "./voice.js";
import { MediaHandler } from "./media.js";

// Load .env.local first, then .env
loadEnv({ path: ".env.local" });
loadEnv();

const OWNER_JID = process.env.WHATSAPP_OWNER_JID;

if (!OWNER_JID) {
  console.error(
    "Error: WHATSAPP_OWNER_JID is required.\n" +
      "Set it in apps/relay-adapter-whatsapp/.env.local\n" +
      "Example: WHATSAPP_OWNER_JID=256XXXXXXXXX@s.whatsapp.net\n\n" +
      "This is the JID for your WhatsApp self-chat (message yourself).\n" +
      "The agent will ONLY see messages in this chat — nothing else.",
  );
  process.exit(1);
}

// ── Create immutable security guard ──────────────────────────────
let guard: WhatsAppGuard;
try {
  guard = new WhatsAppGuard(OWNER_JID);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║  WhatsApp Relay Adapter for Agent-HQ                   ║");
console.log("╠══════════════════════════════════════════════════════════╣");
console.log(`║  SECURITY: Locked to self-chat only                    ║`);
console.log(`║  Owner JID: ${guard.ownerJid.padEnd(43)}║`);
console.log(`║  All other conversations are INVISIBLE to the agent    ║`);
console.log("╚══════════════════════════════════════════════════════════╝");

// ── Voice note support (optional) ────────────────────────────────
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
  console.log(
    `[whatsapp] Voice transcription enabled (Groq whisper-large-v3-turbo)`,
  );
  console.log(`[whatsapp] Voice replies: ${ttsStatus}`);
} else {
  console.log(
    "[whatsapp] Voice support disabled — set GROQ_API_KEY to enable transcription",
  );
}

// ── Media handler (optional but recommended) ─────────────────────
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
    `[whatsapp] AI vision enabled (model: ${visionModel ?? "google/gemini-2.5-flash-preview-05-20"})`,
  );
} else {
  console.log(
    "[whatsapp] AI vision disabled — set OPENROUTER_API_KEY to enable image descriptions",
  );
}
console.log(`[whatsapp] Media auto-processing: ${mediaAutoProcess ? "on" : "off"}`);

// ── Create bridge and bot ────────────────────────────────────────
const bridge = new WhatsAppBridge({
  guard,
  logLevel:
    process.env.DEBUG === "true" || process.env.DEBUG === "1"
      ? "debug"
      : "warn",
  linkPreviews: true,
});

const bot = new RelayWhatsAppBot({
  guard,
  bridge,
  relayHost: process.env.RELAY_HOST,
  relayPort: process.env.RELAY_PORT
    ? parseInt(process.env.RELAY_PORT, 10)
    : undefined,
  apiKey: process.env.AGENTHQ_API_KEY,
  debug: process.env.DEBUG === "true" || process.env.DEBUG === "1",
  voiceHandler,
  mediaHandler,
  mediaAutoProcess,
});

bot.start().catch((err) => {
  console.error("[relay-whatsapp] Failed to start:", err);
  process.exit(1);
});

process.on("SIGINT", async () => {
  console.log("\n[relay-whatsapp] Shutting down...");
  await bot.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await bot.stop();
  process.exit(0);
});

/**
 * Relay Google Chat Adapter — entry point.
 *
 * Runs a local HTTP server that receives push events from the Google Chat App,
 * routes messages through the HQ agent relay server, and replies via Chat API.
 *
 * Architecture:
 *   1. Register a Google Chat App in Cloud Console (one-time setup)
 *   2. Point its HTTP endpoint to this server (via Tailscale Funnel)
 *   3. Google Chat pushes MESSAGE events here
 *   4. We route to relay server → LLM → reply via Chat REST API
 *
 * SECURITY: Only messages from GOOGLE_CHAT_USER_ID are processed.
 *
 * Required env vars:
 *   GOOGLE_CHAT_SA_KEY_FILE     Path to service account JSON key file
 *   GOOGLE_CHAT_USER_ID         Your Google Chat user ID (e.g. "users/123456789")
 *
 * Optional:
 *   GOOGLE_CHAT_PORT            HTTP server port (default: 18901)
 *   GOOGLE_CHAT_VERIFICATION_TOKEN  Token from Chat App config (extra security)
 *   RELAY_HOST                  Relay server host (default: 127.0.0.1)
 *   RELAY_PORT                  Relay server port (default: 18900)
 *   AGENTHQ_API_KEY             API key for relay server authentication
 *   DEBUG                       Enable debug logging (true/1)
 *
 * Setup guide:
 *   1. Create a service account in Google Cloud Console (project: praxis-flows)
 *   2. Download the JSON key file
 *   3. Go to Google Chat API → Configuration
 *   4. Set App name, avatar, description
 *   5. Under "Connection settings", choose "HTTP endpoint URL"
 *   6. Set URL to your Tailscale Funnel URL (e.g. https://your-machine.ts.net:18901)
 *   7. Optionally set a verification token
 *   8. Under "Visibility", add yourself or make it available to your domain
 *   9. Enable Tailscale Funnel: tailscale funnel 18901
 *   10. Start this adapter: bun googlechat
 */

import { config as loadEnv } from "dotenv";
import path from "node:path";
import { existsSync } from "node:fs";
import { GoogleChatGuard } from "./guard.js";
import { GoogleChatBridge } from "./googlechat.js";
import { RelayGoogleChatBot } from "./bot.js";
import { loadServiceAccount } from "./gwsClient.js";

// Load env: local .env.local first, then root .env.local, then .env
const rootDir = path.resolve(import.meta.dir, "../../..");
loadEnv({ path: ".env.local" });
loadEnv({ path: path.join(rootDir, ".env.local") });
loadEnv();

const SA_KEY_FILE = process.env.GOOGLE_CHAT_SA_KEY_FILE;
const USER_ID = process.env.GOOGLE_CHAT_USER_ID;
const PORT = parseInt(process.env.GOOGLE_CHAT_PORT ?? "18901", 10);

if (!SA_KEY_FILE) {
  console.error(
    "Error: GOOGLE_CHAT_SA_KEY_FILE is required.\n" +
      "This is the path to your Google Cloud service account JSON key file.\n" +
      "Setup:\n" +
      "  1. Go to Google Cloud Console → IAM & Admin → Service Accounts\n" +
      "  2. Create a service account (or use an existing one)\n" +
      "  3. Create a JSON key and download it\n" +
      "  4. Set GOOGLE_CHAT_SA_KEY_FILE=/path/to/key.json in .env.local\n" +
      "  5. Configure the Chat App to use this service account\n" +
      "     (Google Chat API → Configuration → Connection settings)",
  );
  process.exit(1);
}

if (!existsSync(SA_KEY_FILE)) {
  console.error(`Error: Service account key file not found: ${SA_KEY_FILE}`);
  process.exit(1);
}

if (!USER_ID) {
  console.error(
    "Error: GOOGLE_CHAT_USER_ID is required.\n" +
      "This is your Google Chat user ID (e.g. 'users/123456789').\n" +
      "Find it:\n" +
      "  1. Add the Chat App to a space and send a message\n" +
      "  2. Check the server logs — the sender user ID will be printed\n" +
      "  3. Set GOOGLE_CHAT_USER_ID=users/XXXX in .env.local",
  );
  process.exit(1);
}

// Load service account credentials
try {
  loadServiceAccount(SA_KEY_FILE);
} catch (err) {
  console.error("Error loading service account key:", err);
  process.exit(1);
}

// Create immutable security guard
let guard: GoogleChatGuard;
try {
  guard = new GoogleChatGuard(USER_ID);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const isDebug = process.env.DEBUG === "true" || process.env.DEBUG === "1";

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║  Google Chat Relay Adapter for Agent-HQ                ║");
console.log("╠══════════════════════════════════════════════════════════╣");
console.log(`║  SECURITY: Locked to owner only                        ║`);
console.log(`║  Owner ID: ${guard.ownerUserId.padEnd(44)}║`);
console.log(`║  Port:     ${String(PORT).padEnd(44)}║`);
console.log(`║  SA Key:   ${path.basename(SA_KEY_FILE).padEnd(44)}║`);
console.log("╠══════════════════════════════════════════════════════════╣");
console.log("║  Expose via Tailscale Funnel:                          ║");
console.log(`║    tailscale funnel ${String(PORT).padEnd(36)}║`);
console.log("╚══════════════════════════════════════════════════════════╝");

// Create bridge and bot
const bridge = new GoogleChatBridge({
  guard,
  port: PORT,
  verificationToken: process.env.GOOGLE_CHAT_VERIFICATION_TOKEN,
  debug: isDebug,
});

const bot = new RelayGoogleChatBot({
  guard,
  bridge,
  relayHost: process.env.RELAY_HOST,
  relayPort: process.env.RELAY_PORT ? parseInt(process.env.RELAY_PORT, 10) : undefined,
  apiKey: process.env.AGENTHQ_API_KEY,
  debug: isDebug,
});

bot.start().catch((err) => {
  console.error("[relay-googlechat] Failed to start:", err);
  process.exit(1);
});

process.on("SIGINT", async () => {
  console.log("\n[relay-googlechat] Shutting down...");
  await bot.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await bot.stop();
  process.exit(0);
});

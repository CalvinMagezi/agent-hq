/**
 * Setup Discord Settings for Testing
 *
 * Quick test script to verify Discord settings can be loaded from .env.local
 *
 * IMPORTANT: For production, set these via the web UI or Convex dashboard.
 * This script is just for quick testing.
 */

import dotenv from "dotenv";
import * as path from "path";

// Load environment variables
dotenv.config({ path: path.join(process.cwd(), ".env.local") });

console.log("📋 Discord Settings from .env.local:\n");

const settings = [
    { key: "DISCORD_BOT_TOKEN", masked: true },
    { key: "DISCORD_USER_ID", masked: false },
    { key: "DISCORD_BOT_ID", masked: false },
    { key: "DISCORD_GUILD_ID", masked: false },
];

let allSet = true;

for (const setting of settings) {
    const value = process.env[setting.key];
    if (value) {
        const display = setting.masked
            ? value.substring(0, 20) + "..."
            : value;
        console.log(`✅ ${setting.key}: ${display}`);
    } else {
        console.log(`❌ ${setting.key}: NOT SET`);
        allSet = false;
    }
}

console.log("\n" + "=".repeat(60));

if (allSet) {
    console.log("\n✨ All Discord credentials are configured!");
    console.log("\n📝 To enable Discord presence:");
    console.log("   1. Start Convex: cd packages/convex && npx convex dev");
    console.log("   2. Open Convex dashboard and manually insert settings:");
    console.log("      - discord_bot_token = <YOUR_TOKEN>");
    console.log("      - discord_user_id = <YOUR_USER_ID>");
    console.log("      - discord_enable_presence = true");
    console.log("      - discord_presence_type = activity");
    console.log("\n   OR use the web app settings UI once it's built");
    console.log("\n   Then start agent: bun run agent");
} else {
    console.log("\n❌ Some Discord credentials are missing!");
    console.log("   Add them to apps/agent/.env.local");
}

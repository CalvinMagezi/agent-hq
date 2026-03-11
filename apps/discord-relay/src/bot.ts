import { type Interaction } from "discord.js";
import { join } from "path";
import {
  UnifiedAdapterBot,
  type UnifiedAdapterBotConfig,
  buildPlatformConfig,
} from "@repo/relay-adapter-core";
import { DiscordBridge } from "./discordBridge.js";
import { VaultAPI } from "./vaultApi.js";
import type { RelayConfig } from "./types.js";
import { getSlashCommandDefs, handleSlashCommand, handleAutocomplete } from "./slashCommands.js";

export function buildConfig(): RelayConfig {
  return {
    discordBotToken: process.env.DISCORD_BOT_TOKEN || "",
    discordUserId: process.env.DISCORD_USER_ID!,
    discordBotId: process.env.DISCORD_BOT_ID,
    claudePath: process.env.CLAUDE_PATH || "claude",
    projectDir: process.env.PROJECT_DIR || process.cwd(),
    relayDir: process.env.RELAY_DIR || ".discord-relay",
    convexUrl: "",
    convexSiteUrl: "",
    apiKey: process.env.AGENTHQ_API_KEY || "local-master-key",
    vaultPath: process.env.VAULT_PATH,
    uploadsDir: join(process.env.RELAY_DIR || ".discord-relay", "uploads"),
    userName: process.env.USER_NAME,
    timezone:
      process.env.USER_TIMEZONE ||
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    voiceProvider: (process.env.VOICE_PROVIDER as "groq" | "whisper" | "none") || "none",
    groqApiKey: process.env.GROQ_API_KEY,
    whisperPath: process.env.WHISPER_PATH,
    whisperModel: process.env.WHISPER_MODEL,
  };
}

/**
 * DiscordBotInstance — a slim wrapper around UnifiedAdapterBot.
 * Handles Discord-specific lifecycle (slash commands, heartbeats).
 */
export class BotInstance {
  private bot: UnifiedAdapterBot;
  private bridge: DiscordBridge;
  private convex: VaultAPI;
  private config: RelayConfig;
  private agentId: string;
  private harnessType: string;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: RelayConfig, harness: { harnessName: string }, _sharedSync?: any) {
    this.config = config;
    this.harnessType = harness.harnessName.toLowerCase().replace(/\s+/g, "-");
    this.agentId = `discord-relay-${this.harnessType}`;
    
    this.bridge = new DiscordBridge(config);
    this.convex = new VaultAPI(config);

    const botConfig: UnifiedAdapterBotConfig = {
      bridge: this.bridge,
      platformConfig: buildPlatformConfig("discord", {
        defaultTimeout: 120_000,
        harnessTimeouts: { relay: 120_000 },
      }),
      relay: {
        apiKey: config.apiKey,
        debug: true,
      },
      vaultRoot: config.vaultPath,
      stateFile: join(config.relayDir, "state.json"),
    };

    this.bot = new UnifiedAdapterBot(botConfig);

    // Wire up Discord-specific interaction handling
    // We override the bridge's onInteraction if we wanted, 
    // but DiscordBridge already handles buttons.
    // Index-level slash commands are handled here.
  }

  async start(): Promise<void> {
    // Start the unified bot
    await this.bot.start();

    // Heartbeat registration for old Convex system (legacy)
    const heartbeatMeta = {
      type: "discord-relay",
      name: `Discord Relay (${this.harnessType})`,
      harnessType: this.harnessType,
      capabilities: ["unified-bot"],
    };
    const convex = this.convex;
    const agentId = this.agentId;
    if (convex) {
      (this.heartbeatInterval as any) = setInterval(() => {
        convex.sendHeartbeat(agentId, "online", heartbeatMeta).catch(() => {});
      }, 20000);
    }

    // Register slash commands on the bridge
    this.bridge.addReadyCallback(async () => {
      try {
        const defs = getSlashCommandDefs(this.harnessType);
        const client = this.bridge.getClient();
        if (client?.application) {
          await client.application.commands.set(defs.map((d) => d.data.toJSON()));
          console.log(`[Discord] Registered ${defs.length} slash commands`);
        }
      } catch (err: any) {
        console.error(`[Discord] Failed to register slash commands:`, err.message);
      }
    });

    // Native interaction handler (slash commands)
    const client = this.bridge.getClient();
    client?.on("interactionCreate", async (interaction: Interaction) => {
      if (interaction.isChatInputCommand()) {
        await handleSlashCommand(interaction as any, {
          harness: { harnessName: this.harnessType } as any,
          config: this.config,
          convex: this.convex,
          enricher: {} as any, // Legacy
          threadManager: {} as any, // Legacy
        });
      } else if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction as any, { harnessName: this.harnessType } as any);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    await this.convex.sendHeartbeat(this.agentId, "offline").catch(() => {});
    await this.bot.stop();
  }
}

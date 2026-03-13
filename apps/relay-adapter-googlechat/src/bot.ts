/**
 * GoogleChatBot — thin bridge connecting GoogleChatBridge to UnifiedAdapterBot.
 *
 * Handles only Google Chat-specific commands (!spaces) — everything else
 * delegates to UnifiedAdapterBot (routing, chat, delegation, memory, etc.).
 */

import { UnifiedAdapterBot, buildPlatformConfig } from "@repo/relay-adapter-core";
import type { UnifiedAdapterBotConfig, UnifiedMessage } from "@repo/relay-adapter-core";
import type { GoogleChatBridge } from "./googlechat.js";
import type { GoogleChatGuard } from "./guard.js";
import * as gws from "./gwsClient.js";

const VAULT_ROOT = ".vault";

// ─── Config ───────────────────────────────────────────────────────

export interface RelayGoogleChatBotConfig {
  guard: GoogleChatGuard;
  bridge: GoogleChatBridge;
  relayHost?: string;
  relayPort?: number;
  apiKey?: string;
  debug?: boolean;
}

// ─── GoogleChatBot ────────────────────────────────────────────────

export class RelayGoogleChatBot {
  private bridge: GoogleChatBridge;
  private bot: UnifiedAdapterBot;

  constructor(config: RelayGoogleChatBotConfig) {
    this.bridge = config.bridge;

    const botConfig: UnifiedAdapterBotConfig = {
      bridge: config.bridge,
      platformConfig: buildPlatformConfig("google-chat"),
      relay: {
        host: config.relayHost,
        port: config.relayPort,
        apiKey: config.apiKey,
        debug: config.debug,
      },
      vaultRoot: VAULT_ROOT,
    };

    this.bot = new GoogleChatAdapterBot(botConfig, this.bridge);
  }

  async start(): Promise<void> {
    await this.bot.start();
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}

// ─── GoogleChatAdapterBot (extends UnifiedAdapterBot) ─────────────

class GoogleChatAdapterBot extends UnifiedAdapterBot {
  private gcBridge: GoogleChatBridge;

  constructor(config: UnifiedAdapterBotConfig, bridge: GoogleChatBridge) {
    super(config);
    this.gcBridge = bridge;
  }

  /** Handle Google Chat-specific commands. */
  protected override async onUnknownCommand(
    cmd: string,
    _argStr: string,
    _msg: UnifiedMessage,
  ): Promise<void> {
    switch (cmd) {
      case "spaces": {
        try {
          const spaces = await gws.listSpaces();
          if (spaces.length === 0) {
            await this.gcBridge.sendText("No spaces found.", { chatId: _msg.chatId });
            return;
          }
          const lines = spaces.map((s) => {
            const label = s.displayName || s.type || "DM";
            return `- ${s.name} (${label})`;
          });
          await this.gcBridge.sendText(
            `*Available Spaces (${spaces.length}):*\n${lines.join("\n")}`,
            { chatId: _msg.chatId },
          );
        } catch (err) {
          await this.gcBridge.sendText(`Failed to list spaces: ${err}`, { chatId: _msg.chatId });
        }
        return;
      }

      default:
        await this.gcBridge.sendText(
          `Unknown command: \`!${cmd}\`. Try \`!help\`.`,
          { chatId: _msg.chatId },
        );
    }
  }
}

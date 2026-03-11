/**
 * RelayWhatsAppBot — thin bridge connecting WhatsAppBridge to UnifiedAdapterBot.
 *
 * ~175 LOC. Handles only WhatsApp-specific logic:
 *   - !forward: forward last received message
 *   - !poll: send a WhatsApp poll
 *   - Message update notifications (poll votes, edits, deletes)
 *   - Connection state reporting
 *
 * All orchestration (commands, chat relay, delegation, voice, media)
 * is handled by UnifiedAdapterBot.
 *
 * Migrated from the original 1718 LOC bot.ts as part of the
 * Unified Relay Architecture (magical-crafting-chipmunk.md).
 */

import { UnifiedAdapterBot, buildPlatformConfig } from "@repo/relay-adapter-core";
import type { UnifiedAdapterBotConfig, UnifiedMessage } from "@repo/relay-adapter-core";
import type { WhatsAppBridge, WhatsAppMessage } from "./whatsapp.js";
import type { VoiceHandler } from "./voice.js";
import type { MediaHandler } from "./media.js";

const VAULT_ROOT = ".vault";

// ─── Config ───────────────────────────────────────────────────────

export interface RelayWhatsAppBotConfig {
  bridge: WhatsAppBridge;
  relayHost?: string;
  relayPort?: number;
  apiKey?: string;
  debug?: boolean;
  voiceHandler?: VoiceHandler;
  mediaHandler?: MediaHandler;
  mediaAutoProcess?: boolean;
  stateFile?: string;
}

// ─── RelayWhatsAppBot ─────────────────────────────────────────────

export class RelayWhatsAppBot {
  private bridge: WhatsAppBridge;
  private bot: UnifiedAdapterBot;
  private lastRawMsg: WhatsAppMessage | null = null;

  constructor(config: RelayWhatsAppBotConfig) {
    this.bridge = config.bridge;

    // Wire raw WhatsApp message handler to keep track of last message key
    // (needed for !forward and poll-update tracking)
    this.bridge.onWhatsAppMessage((rawMsg) => {
      this.lastRawMsg = rawMsg;
    });

    // Wire message update callback (poll votes, edits, deletes)
    this.bridge.onMessageUpdate((update) => {
      this.handleMessageUpdate(update);
    });

    const botConfig: UnifiedAdapterBotConfig = {
      bridge: config.bridge,
      platformConfig: buildPlatformConfig("whatsapp"),
      relay: { host: config.relayHost, port: config.relayPort, apiKey: config.apiKey, debug: config.debug },
      voiceHandler: config.voiceHandler,
      mediaHandler: config.mediaHandler,
      mediaAutoProcess: config.mediaAutoProcess,
      stateFile: config.stateFile,
      vaultRoot: VAULT_ROOT,
    };

    this.bot = new WhatsAppAdapterBot(botConfig, this);
  }

  async start(): Promise<void> {
    await this.bot.start();
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    this.bridge.destroy();
  }

  getLastRawMsg(): WhatsAppMessage | null {
    return this.lastRawMsg;
  }

  /** Handle poll votes, edits, deletes — currently just notifies the user. */
  private handleMessageUpdate(update: {
    type: "poll_vote" | "edit" | "delete" | "status";
    messageId: string;
    data?: any;
  }): void {
    switch (update.type) {
      case "poll_vote": {
        const { pollName, votes } = update.data ?? {};
        if (pollName && votes && Array.isArray(votes) && votes.length > 0) {
          const voteStr = votes.map((v: { name: string; count: number }) =>
            `${v.name}: ${v.count}`
          ).join(", ");
          this.bridge.sendText(`_Poll update — ${pollName}: ${voteStr}_`).catch(console.error);
        }
        break;
      }
      case "delete":
        console.log(`[whatsapp-bot] Message ${update.messageId} deleted`);
        break;
      case "edit": {
        const { newText } = update.data ?? {};
        if (newText) {
          console.log(`[whatsapp-bot] Message ${update.messageId} edited: "${newText.substring(0, 40)}"`);
        }
        break;
      }
    }
  }
}

// ─── WhatsAppAdapterBot (extends UnifiedAdapterBot with WA-specific commands) ─

class WhatsAppAdapterBot extends UnifiedAdapterBot {
  private waBot: RelayWhatsAppBot;
  private waBridge: WhatsAppBridge;

  constructor(config: UnifiedAdapterBotConfig, parent: RelayWhatsAppBot) {
    super(config);
    this.waBot = parent;
    this.waBridge = config.bridge as unknown as WhatsAppBridge;
  }

  /** Handle WhatsApp-specific commands (!poll, !forward). */
  protected override async onUnknownCommand(
    cmd: string,
    argStr: string,
    _msg: UnifiedMessage,
  ): Promise<void> {
    switch (cmd) {
      case "poll": {
        const pollParts = argStr.split("|").map((s) => s.trim());
        if (pollParts.length < 3) {
          await this.waBridge.sendText(
            "Usage: `!poll Question | Option 1 | Option 2 | ...`\n" +
            "Example: `!poll Favorite color | Red | Blue | Green`",
          );
          return;
        }
        await this.waBridge.sendPoll(pollParts[0], pollParts.slice(1));
        return;
      }

      case "forward": {
        const lastRaw = this.waBot.getLastRawMsg();
        if (!lastRaw?.rawMessage) {
          await this.waBridge.sendText("No recent message to forward.");
          return;
        }
        await this.waBridge.forwardMessage(lastRaw.rawMessage);
        return;
      }

      case "location":
      case "loc": {
        const locParts = argStr.split(/\s+/);
        if (locParts.length < 2) {
          await this.waBridge.sendText(
            "Usage: `!location <lat> <lng>`\nExample: `!location 0.3476 32.5825`",
          );
          return;
        }
        const lat = parseFloat(locParts[0]);
        const lng = parseFloat(locParts[1]);
        if (isNaN(lat) || isNaN(lng)) {
          await this.waBridge.sendText("Invalid coordinates. Use decimal numbers.");
          return;
        }
        await this.waBridge.sendLocation(lat, lng);
        return;
      }

      default:
        await this.waBridge.sendText(`Unknown command: \`!${cmd}\`. Try \`!help\`.`);
    }
  }
}

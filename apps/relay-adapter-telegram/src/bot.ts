/**
 * TelegramBot — thin bridge connecting TelegramBridge to UnifiedAdapterBot.
 *
 * ~200 LOC. Handles only Telegram-specific commands (!poll, !pin, !diagram,
 * !location, !edit, !delete) — everything else delegates to UnifiedAdapterBot.
 *
 * Migrated from the original 1508 LOC bot.ts as part of the
 * Unified Relay Architecture (magical-crafting-chipmunk.md).
 */

import { execSync, type ExecSyncOptions } from "child_process";
import { readFileSync, existsSync } from "fs";
import { basename, join, resolve } from "path";
import { UnifiedAdapterBot, buildPlatformConfig } from "@repo/relay-adapter-core";
import type { UnifiedAdapterBotConfig } from "@repo/relay-adapter-core";
import type { UnifiedMessage } from "@repo/relay-adapter-core";
import { InlineKeyboard, type TelegramBridge } from "./telegram.js";
import type { TelegramGuard } from "./guard.js";
import type { VoiceHandler } from "./voice.js";
import type { MediaHandler } from "./media.js";

const VAULT_ROOT = ".vault";

// ─── Config ───────────────────────────────────────────────────────

export interface RelayTelegramBotConfig {
  guard: TelegramGuard;
  bridge: TelegramBridge;
  relayHost?: string;
  relayPort?: number;
  apiKey?: string;
  debug?: boolean;
  voiceHandler?: VoiceHandler;
  mediaHandler?: MediaHandler;
  mediaAutoProcess?: boolean;
  stateFile?: string;
}

// ─── TelegramBot ──────────────────────────────────────────────────

export class RelayTelegramBot {
  private bridge: TelegramBridge;
  private bot: UnifiedAdapterBot;
  private lastSentMsgId: string | null = null;
  private guard: TelegramGuard;

  constructor(config: RelayTelegramBotConfig) {
    this.bridge = config.bridge;
    this.guard = config.guard;

    // Wire the TelegramBridge callback query handler to fire action events
    this.bridge.onCallbackQuery((queryId, data, _chatId) => {
      this.bridge.answerCallbackQuery(queryId, undefined).catch(() => {});
      // Invoke the action handler that UnifiedAdapterBot registered via bridge.onAction()
      const syntheticAction = {
        type: "button_press" as const,
        actionId: data,
        chatId: String(_chatId),
        userId: "0",
        queryId,
      };
      (this.bridge as any).actionCallback?.(syntheticAction);
    });

    // Override sendText to capture last sent message ID for !pin/!delete
    const originalSendText = this.bridge.sendText.bind(this.bridge);
    this.bridge.sendText = async (text, opts) => {
      const msgId = await originalSendText(text, opts);
      if (msgId) {
        this.lastSentMsgId = msgId;
        this.bridge.cacheMessage(Number(msgId), text);
      }
      return msgId;
    };

    const botConfig: UnifiedAdapterBotConfig = {
      bridge: config.bridge,
      platformConfig: buildPlatformConfig("telegram"),
      relay: { host: config.relayHost, port: config.relayPort, apiKey: config.apiKey, debug: config.debug },
      voiceHandler: config.voiceHandler,
      mediaHandler: config.mediaHandler,
      mediaAutoProcess: config.mediaAutoProcess,
      stateFile: config.stateFile,
      vaultRoot: VAULT_ROOT,
    };

    // Extend UnifiedAdapterBot with Telegram-specific overrides
    this.bot = new TelegramAdapterBot(botConfig, this);
  }

  async start(): Promise<void> {
    await this.bot.start();
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  getLastSentMsgId(): string | null {
    return this.lastSentMsgId;
  }
}

// ─── TelegramAdapterBot (extends UnifiedAdapterBot with TG-specific commands) ─

class TelegramAdapterBot extends UnifiedAdapterBot {
  private telegramBot: RelayTelegramBot;
  private tgBridge: TelegramBridge;

  constructor(config: UnifiedAdapterBotConfig, parent: RelayTelegramBot) {
    super(config);
    this.telegramBot = parent;
    this.tgBridge = config.bridge as unknown as TelegramBridge;
  }

  /** Show inline keyboard for harness picker. */
  protected override async onHarnessPickerRequest(): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text("Claude Code", "harness:claude-code")
      .text("OpenCode", "harness:opencode")
      .row()
      .text("Gemini CLI", "harness:gemini-cli")
      .text("Codex CLI", "harness:codex-cli")
      .row()
      .text("Auto", "harness:auto");

    await this.tgBridge.sendMessageWithKeyboard(
      `<b>Select a harness:</b>`,
      keyboard,
    );
  }

  /** Handle Telegram-specific commands (!poll, !pin, !diagram, !location, !edit, !delete). */
  protected override async onUnknownCommand(
    cmd: string,
    argStr: string,
    msg: UnifiedMessage,
  ): Promise<void> {
    switch (cmd) {
      case "pin": {
        const lastId = this.telegramBot.getLastSentMsgId();
        if (!lastId) {
          await this.tgBridge.sendText("No recent bot message to pin.");
          return;
        }
        await this.tgBridge.pinMessage(Number(lastId));
        return;
      }

      case "delete":
      case "del": {
        const lastId = this.telegramBot.getLastSentMsgId();
        if (!lastId) {
          await this.tgBridge.sendText("No recent bot message to delete.");
          return;
        }
        await this.tgBridge.deleteMessageById(Number(lastId));
        return;
      }

      case "edit": {
        if (!argStr) {
          await this.tgBridge.sendText("Usage: `!edit <new text>`");
          return;
        }
        const lastId = this.telegramBot.getLastSentMsgId();
        if (!lastId) {
          await this.tgBridge.sendText("No recent bot message to edit.");
          return;
        }
        await this.tgBridge.editMessageById(Number(lastId), argStr);
        return;
      }

      case "poll": {
        const pollParts = argStr.split("|").map((s) => s.trim());
        if (pollParts.length < 3) {
          await this.tgBridge.sendText(
            "Usage: `!poll Question | Option 1 | Option 2 | ...`\n" +
            "Example: `!poll Favorite color | Red | Blue | Green`",
          );
          return;
        }
        await this.tgBridge.sendPoll(pollParts[0], pollParts.slice(1));
        return;
      }

      case "location":
      case "loc": {
        const locParts = argStr.split(/\s+/);
        if (locParts.length < 2) {
          await this.tgBridge.sendText(
            "Usage: `!location <lat> <lng>`\n" +
            "Example: `!location 0.3476 32.5825`",
          );
          return;
        }
        const lat = parseFloat(locParts[0]);
        const lng = parseFloat(locParts[1]);
        if (isNaN(lat) || isNaN(lng)) {
          await this.tgBridge.sendText("Invalid coordinates. Use decimal numbers.");
          return;
        }
        await this.tgBridge.sendLocation(lat, lng);
        return;
      }

      case "diagram":
      case "draw": {
        if (!argStr) {
          await this.tgBridge.sendText(
            "**Diagram Commands**\n\n" +
            "`!diagram flow \"Step 1\" \"Step 2\" \"Decision?\" \"Done\"`\n" +
            '`!diagram create --title "Name" --nodes "A,B,C" --edges "A>B,B>C"`\n' +
            "`!diagram map [path]`\n" +
            "`!diagram deps [path]`",
          );
          return;
        }
        try {
          await this.tgBridge.sendChatAction("typing");
          const opts: ExecSyncOptions = {
            timeout: 30_000,
            encoding: "utf-8",
            env: { ...process.env, FORCE_COLOR: "0" },
          };
          const diagramArgs = argStr.trim().split(/\s+/).filter(Boolean);
          const { spawnSync } = await import("child_process");
          const result = spawnSync("hq", ["diagram", ...diagramArgs], {
            timeout: 30_000,
            encoding: "utf-8",
            env: { ...process.env, FORCE_COLOR: "0" },
          });
          const output = (result.stdout || "") as string;
          const fileMatch = output.match(/\[FILE:\s*([^\]|]+?)(?:\s*\|\s*([^\]]+?))?\s*\]/);
          if (fileMatch) {
            const filePath = fileMatch[1].trim();
            if (existsSync(filePath)) {
              const buffer = readFileSync(filePath);
              await this.tgBridge.sendPhoto(Buffer.from(buffer), fileMatch[2]?.trim() ?? "diagram");
              return;
            }
          }
          const cleanOutput = output.replace(/\[FILE:[^\]]+\]/g, "").replace(/\n{3,}/g, "\n").trim();
          await this.tgBridge.sendText(cleanOutput.substring(0, 2000) || "Diagram generated.");
        } catch (err: any) {
          const errMsg = err.stderr?.toString().trim() || err.message || "Unknown error";
          await this.tgBridge.sendText(`Diagram error: ${errMsg.substring(0, 500)}`);
        }
        return;
      }

      case "export": {
        if (!argStr) {
          await this.tgBridge.sendText(
            "Usage: `!export <relative-vault-path>`\nExample: `!export Notebooks/Projects/report.md`",
          );
          return;
        }
        const exportPath = resolve(VAULT_ROOT, argStr);
        const resolvedVault = resolve(VAULT_ROOT);
        if (!exportPath.startsWith(resolvedVault + "/")) {
          await this.tgBridge.sendText("Export path must be within the vault.");
          return;
        }
        await this.tgBridge.sendDocumentFromPath(exportPath, `📎 ${basename(exportPath)}`);
        return;
      }

      default:
        await this.tgBridge.sendText(`Unknown command: \`!${cmd}\`. Try \`!help\`.`);
    }
  }
}

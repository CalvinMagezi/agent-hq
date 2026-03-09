/**
 * RelayTelegramBot — Routes Telegram messages through the relay server.
 *
 * Supports text, media (photos/video/docs/stickers), voice notes,
 * locations, contacts, polls. AI vision for received images,
 * Telegram HTML formatting, inline keyboards for harness selection.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { basename } from "path";
import { LocalHarness } from "./localHarness.js";
import { RelayClient } from "@repo/agent-relay-protocol";
import type {
  RelayClientConfig,
  CmdResultMessage,
  ChatDeltaMessage,
  ChatFinalMessage,
} from "@repo/agent-relay-protocol";
import type { TelegramBridge, TelegramMessage } from "./telegram.js";
import { InlineKeyboard } from "./telegram.js";
import type { TelegramGuard } from "./guard.js";
import type { VoiceHandler } from "./voice.js";
import type { MediaHandler } from "./media.js";
import { detectIntent } from "./orchestrator.js";
import { formatForTelegram, stripHtml } from "./formatter.js";
import { SessionOrchestrator } from "./sessionOrchestrator.js";

type ActiveHarness = "auto" | "claude-code" | "opencode" | "gemini-cli" | "codex-cli";

/** Max chars per Telegram message (API limit is 4096). */
const MAX_CHUNK_SIZE = 4000;

/** Typing indicator keepalive (Telegram typing expires ~5s). */
const TYPING_KEEPALIVE_MS = 4_000;

/** Convert any audio file to OGG Opus buffer for Telegram sendVoice. */
function convertToOgg(inputPath: string): Buffer {
  const outPath = inputPath.replace(/\.[^.]+$/, "") + "-tg.ogg";
  try {
    execSync(
      `ffmpeg -y -i "${inputPath}" -c:a libopus -b:a 32k -vbr on "${outPath}"`,
      { stdio: "pipe" }
    );
    const buf = readFileSync(outPath);
    try { unlinkSync(outPath); } catch {}
    return buf;
  } catch {
    // ffmpeg failed — send raw buffer and let Telegram handle it
    return readFileSync(inputPath);
  }
}

function harnessFromPath(filePath: string): string | null {
  if (filePath.includes("gemini")) return "Gemini";
  if (filePath.includes("claude")) return "Claude Code";
  if (filePath.includes("opencode")) return "OpenCode";
  return null;
}

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

export class RelayTelegramBot {
  private relay: RelayClient;
  private bridge: TelegramBridge;
  private guard: TelegramGuard;
  private voiceHandler: VoiceHandler | null;
  private mediaHandler: MediaHandler | null;
  private voiceReplyEnabled = false;
  private mediaAutoProcess: boolean;
  private formatEnabled = true;
  private processedMessages = new Set<number>();
  private threadId: string | null = null;
  private modelOverride: string | undefined;
  private activeHarness: ActiveHarness = "auto";
  private stateFile: string;
  private localHarness: LocalHarness;
  private sessionOrchestrator: SessionOrchestrator;
  private processing = false;
  private messageQueue: TelegramMessage[] = [];

  /** Active orchestration job tracking */
  private activeJobId: string | null = null;
  private activeJobLabel: string | null = null;
  private activeJobResultDelivered = false;
  private activeTaskIds = new Set<string>();

  /** Track last received/sent messages for !delete, !edit */
  private lastReceivedMsgId: number | null = null;
  private lastSentMsgId: number | null = null;

  constructor(config: RelayTelegramBotConfig) {
    this.guard = config.guard;
    this.bridge = config.bridge;
    this.voiceHandler = config.voiceHandler ?? null;
    this.mediaHandler = config.mediaHandler ?? null;
    this.mediaAutoProcess = config.mediaAutoProcess ?? true;
    this.stateFile = config.stateFile ?? ".telegram-state.json";
    this.loadState();
    this.localHarness = new LocalHarness(".telegram-harness-sessions.json");
    this.sessionOrchestrator = new SessionOrchestrator(this.localHarness);

    const relayConfig: RelayClientConfig = {
      host: config.relayHost,
      port: config.relayPort,
      apiKey: config.apiKey ?? "",
      clientId: "telegram-relay-adapter",
      clientType: "telegram",
      autoReconnect: true,
      debug: config.debug,
    };

    this.relay = new RelayClient(relayConfig);
  }

  async start(): Promise<void> {
    // Connect to relay server
    console.log("[relay-telegram] Connecting to relay server...");
    await this.relay.connect();
    console.log("[relay-telegram] Connected to relay server");

    // Subscribe to vault events
    this.relay.send({ type: "system:subscribe", events: ["job:*", "task:*"] });
    this.relay.on("system:event", (eventMsg: any) => {
      this.handleVaultEvent(eventMsg.event, eventMsg.data).catch(console.error);
    });

    // Register message handler
    this.bridge.onMessage((msg) => this.handleMessage(msg));

    // Register callback query handler (inline keyboard buttons)
    this.bridge.onCallbackQuery((queryId, data, _chatId) => {
      this.handleCallbackQuery(queryId, data).catch(console.error);
    });

    // Start the Telegram bridge
    await this.bridge.start();
    console.log("[relay-telegram] Telegram bridge started — listening for messages");
  }

  async stop(): Promise<void> {
    this.relay.disconnect();
    await this.bridge.stop();
    if (this.mediaHandler) {
      this.mediaHandler.destroy();
    }
    console.log("[relay-telegram] Bot stopped");
  }

  // ══════════════════════════════════════════════════════════════
  // MESSAGE ROUTING
  // ══════════════════════════════════════════════════════════════

  private async handleMessage(msg: TelegramMessage): Promise<void> {
    console.log(
      `[relay-telegram] handleMessage: id=${msg.id}, content="${msg.content.substring(0, 60)}", ` +
      `mediaType=${msg.mediaType ?? "none"}, voice=${msg.isVoiceNote ?? false}`,
    );

    // Dedup
    if (this.processedMessages.has(msg.id)) {
      return;
    }
    this.processedMessages.add(msg.id);
    if (this.processedMessages.size > 200) {
      const first = this.processedMessages.values().next().value;
      if (first !== undefined) this.processedMessages.delete(first);
    }

    // Track last received message
    this.lastReceivedMsgId = msg.id;

    // Voice note handling
    if (msg.isVoiceNote) {
      if (!this.voiceHandler) {
        await this.sendReply(
          "Voice notes received but transcription is not configured.\n" +
          "Set GROQ_API_KEY in .env.local to enable voice note support.",
          msg,
        );
        return;
      }
      if (!msg.audioBuffer) {
        await this.sendReply("Received a voice note but failed to download the audio.", msg);
        return;
      }
      try {
        console.log("[relay-telegram] Transcribing voice note...");
        await this.bridge.sendChatAction("typing");
        const transcript = await this.voiceHandler.transcribe(msg.audioBuffer);
        if (!transcript) {
          await this.sendReply("I received your voice note but couldn't make out what was said.", msg);
          return;
        }
        console.log(`[relay-telegram] Voice transcribed: "${transcript.substring(0, 80)}"`);
        await this.handleChat(`[Voice note]: ${transcript}`, msg);
        await this.processQueue();
        return;
      } catch (err) {
        console.error("[relay-telegram] Transcription failed:", err);
        await this.sendReply(
          `Failed to transcribe voice note: ${err instanceof Error ? err.message : String(err)}`,
          msg,
        );
        return;
      }
    }

    // Media message handling
    if (msg.mediaType && msg.mediaType !== "audio") {
      await this.handleMediaMessage(msg);
      await this.processQueue();
      return;
    }

    // Location
    if (msg.location) {
      const { lat, lng } = msg.location;
      await this.handleChat(`[Location shared]: ${lat.toFixed(6)}, ${lng.toFixed(6)}`, msg);
      await this.processQueue();
      return;
    }

    // Contact
    if (msg.contactName || msg.contactPhone) {
      await this.handleChat(
        `[Contact shared]: ${msg.contactName ?? "Unknown"} — ${msg.contactPhone ?? ""}`,
        msg,
      );
      await this.processQueue();
      return;
    }

    // Poll
    if (msg.pollQuestion) {
      const pollText = `[Poll received]: ${msg.pollQuestion}\nOptions: ${msg.pollOptions?.join(", ")}`;
      await this.handleChat(pollText, msg);
      await this.processQueue();
      return;
    }

    const content = msg.content.trim();
    if (!content) {
      console.log("[relay-telegram] Empty content, skipping");
      return;
    }

    // Queue if processing
    if (this.processing) {
      console.log(`[relay-telegram] Already processing — queuing: "${content.substring(0, 40)}"`);
      this.messageQueue.push(msg);
      return;
    }

    // Commands
    if (content.startsWith("!")) {
      console.log(`[relay-telegram] Processing command: ${content}`);
      await this.handleBangCommand(content, msg);
      return;
    }

    // Harness routing
    if (this.activeHarness !== "auto") {
      console.log(`[relay-telegram] Local harness ${this.activeHarness}: "${content.substring(0, 60)}"`);
      await this.handleLocalHarness(content, this.activeHarness, msg);
    } else {
      const { intent, harness, role } = detectIntent(content);
      console.log(`[relay-telegram] Intent: ${intent}, harness: ${harness}, role: ${role}`);

      if (intent !== "general" && !this.modelOverride) {
        await this.handleDelegation(content, harness, role);
      } else {
        await this.handleChat(content, msg);
      }
    }

    await this.processQueue();
  }

  // ══════════════════════════════════════════════════════════════
  // MEDIA HANDLING
  // ══════════════════════════════════════════════════════════════

  private async handleMediaMessage(msg: TelegramMessage): Promise<void> {
    const { mediaType, mediaBuffer, mediaMimeType, mediaFilename, mediaSize } = msg;
    const sizeStr = this.mediaHandler?.formatSize(mediaSize ?? 0) ?? `${mediaSize ?? 0}B`;

    if (!mediaBuffer) {
      await this.sendReply(`Received ${mediaType} but failed to download it.`, msg);
      return;
    }

    switch (mediaType) {
      case "photo": {
        if (this.mediaAutoProcess && this.mediaHandler?.canDescribe) {
          await this.bridge.sendChatAction("typing");
          const caption = msg.content ? `\n\nCaption: "${msg.content}"` : "";
          const prompt = msg.content
            ? `Describe this image. The sender included this caption: "${msg.content}"`
            : undefined;
          const description = await this.mediaHandler.describeImage(mediaBuffer, prompt);
          await this.handleChat(
            `[Image received (${sizeStr})]${caption}\n\nAI description: ${description}`,
            msg,
          );
        } else {
          const caption = msg.content ? ` — Caption: "${msg.content}"` : "";
          await this.sendReply(`Image received (${sizeStr})${caption}. AI vision not available.`, msg);
        }
        break;
      }

      case "video":
      case "video_note": {
        const caption = msg.content ? ` — Caption: "${msg.content}"` : "";
        await this.sendReply(`Video received (${sizeStr})${caption}.`, msg);
        break;
      }

      case "document": {
        const fname = mediaFilename ?? "unknown";
        const caption = msg.content ? `\nCaption: "${msg.content}"` : "";

        if (this.mediaAutoProcess && this.mediaHandler && mediaMimeType) {
          const extracted = this.mediaHandler.extractDocumentText(mediaBuffer, mediaMimeType);
          if (extracted.startsWith("(Binary")) {
            await this.handleChat(`[Document: ${fname} (${sizeStr})]${caption}\n\n${extracted}`, msg);
          } else {
            await this.handleChat(`[Document: ${fname} (${sizeStr})]${caption}\n\nContent:\n${extracted}`, msg);
          }
        } else {
          await this.sendReply(`Document received: ${fname} (${sizeStr})${caption}`, msg);
        }
        break;
      }

      case "sticker":
        await this.sendReply(`Sticker received: ${msg.content}`, msg);
        break;

      default:
        await this.sendReply(`${mediaType} received (${sizeStr}).`, msg);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // CALLBACK QUERIES (inline keyboard button presses)
  // ══════════════════════════════════════════════════════════════

  private async handleCallbackQuery(queryId: string, data: string): Promise<void> {
    if (data.startsWith("harness:")) {
      const harness = data.replace("harness:", "") as ActiveHarness;
      const valid: ActiveHarness[] = ["auto", "claude-code", "opencode", "gemini-cli", "codex-cli"];
      if (!valid.includes(harness)) {
        await this.bridge.answerCallbackQuery(queryId, "Unknown harness");
        return;
      }
      this.activeHarness = harness;
      this.saveState();
      await this.bridge.answerCallbackQuery(
        queryId,
        `Switched to ${this.harnessLabel(harness)}`,
      );
      const desc =
        harness === "auto"
          ? "Intent-based routing restored."
          : `All messages will now route to <b>${this.harnessLabel(harness)}</b>.`;
      await this.bridge.sendMessage(`Switched to <b>${this.harnessLabel(harness)}</b>\n\n${desc}`);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // COMMANDS
  // ══════════════════════════════════════════════════════════════

  private async handleBangCommand(content: string, sourceMsg?: TelegramMessage): Promise<void> {
    const parts = content.slice(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const argStr = parts.slice(1).join(" ").trim();

    let command: string | undefined;
    let args: Record<string, unknown> = {};

    switch (cmd) {
      case "reset":
      case "new":
        this.threadId = null;
        this.modelOverride = undefined;
        if (this.activeHarness !== "auto") {
          this.localHarness.resetSession(this.activeHarness);
        }
        await this.bridge.sendMessage(
          `Session reset.\n\n<i>Active harness: ${this.harnessLabel(this.activeHarness)}</i>`,
        );
        return;

      case "model":
        if (argStr) {
          this.modelOverride = argStr;
          await this.bridge.sendMessage(`Model set to: <code>${argStr}</code>`);
          return;
        }
        command = "model";
        break;

      case "opus":
        this.modelOverride = "claude-opus-4-6";
        await this.bridge.sendMessage("Model set to: <code>claude-opus-4-6</code>");
        return;

      case "sonnet":
        this.modelOverride = "claude-sonnet-4-6";
        await this.bridge.sendMessage("Model set to: <code>claude-sonnet-4-6</code>");
        return;

      case "haiku":
        this.modelOverride = "claude-haiku-4-5-20251001";
        await this.bridge.sendMessage("Model set to: <code>claude-haiku-4-5-20251001</code>");
        return;

      case "gemini":
        this.modelOverride = "google/gemini-2.5-flash-preview-05-20";
        await this.bridge.sendMessage(
          "Switched to Gemini 2.5 Flash (via OpenRouter).\n\n" +
          "<i>Note: For Google Workspace tasks (Docs, Drive, Gmail, Calendar), " +
          "use the Gemini bot on Discord for full authenticated access.</i>",
        );
        return;

      case "sessions": {
        const active = this.sessionOrchestrator.getActiveSessions();
        if (active.length === 0) {
          await this.bridge.sendMessage("<i>No active orchestrated sessions.</i>");
        } else {
          const lines = active.map((s) => {
            const elapsedMin = Math.round((Date.now() - s.startedAt) / 60_000);
            return `\u2022 <b>${s.harness}</b> [${s.state}] \u2014 ${elapsedMin}m \u2014 <code>${s.id.slice(-8)}</code>`;
          });
          await this.bridge.sendMessage(`<b>Active sessions:</b>\n${lines.join("\n")}`);
        }
        return;
      }

      case "status":
      case "hq":
        if (this.activeJobId) {
          const label = this.activeJobLabel ?? "task";
          await this.bridge.sendMessage(
            `<b>Active task:</b> ${label}\n` +
            `Job ID: <code>${this.activeJobId}</code>\n` +
            `Status: running \u2014 waiting for result`,
          );
          return;
        }
        command = "status";
        break;

      case "memory":
        command = "memory";
        break;

      case "threads":
        command = "threads";
        break;

      case "search":
        command = "search";
        args.query = argStr;
        break;

      case "voice":
        await this.handleVoiceCommand(argStr);
        return;

      case "poll": {
        const pollParts = argStr.split("|").map((s) => s.trim());
        if (pollParts.length < 3) {
          await this.bridge.sendMessage(
            "Usage: <code>!poll Question | Option 1 | Option 2 | ...</code>\n" +
            "Example: <code>!poll Favorite color | Red | Blue | Green</code>",
          );
          return;
        }
        await this.bridge.sendPoll(pollParts[0], pollParts.slice(1));
        return;
      }

      case "location":
      case "loc": {
        const locParts = argStr.split(/\s+/);
        if (locParts.length < 2) {
          await this.bridge.sendMessage(
            "Usage: <code>!location &lt;lat&gt; &lt;lng&gt;</code>\n" +
            "Example: <code>!location 0.3476 32.5825</code>",
          );
          return;
        }
        const lat = parseFloat(locParts[0]);
        const lng = parseFloat(locParts[1]);
        if (isNaN(lat) || isNaN(lng)) {
          await this.bridge.sendMessage("Invalid coordinates. Use decimal numbers.");
          return;
        }
        await this.bridge.sendLocation(lat, lng);
        return;
      }

      case "delete":
      case "del": {
        if (!this.lastSentMsgId) {
          await this.bridge.sendMessage("No recent bot message to delete.");
          return;
        }
        await this.bridge.deleteMessage(this.lastSentMsgId);
        this.lastSentMsgId = null;
        return;
      }

      case "edit": {
        if (!argStr) {
          await this.bridge.sendMessage("Usage: <code>!edit &lt;new text&gt;</code>");
          return;
        }
        if (!this.lastSentMsgId) {
          await this.bridge.sendMessage("No recent bot message to edit.");
          return;
        }
        await this.bridge.editMessage(this.lastSentMsgId, argStr);
        return;
      }

      case "media": {
        if (argStr === "on") {
          this.mediaAutoProcess = true;
          await this.bridge.sendMessage("Media auto-processing enabled. Images will be described by AI.");
        } else if (argStr === "off") {
          this.mediaAutoProcess = false;
          await this.bridge.sendMessage("Media auto-processing disabled.");
        } else {
          const status = this.mediaAutoProcess ? "on" : "off";
          const vision = this.mediaHandler?.canDescribe ? "available" : "not configured";
          await this.bridge.sendMessage(
            `<b>Media settings</b>\n\nAuto-process: ${status}\nAI vision: ${vision}\n\n` +
            "<code>!media on</code> \u2014 enable AI processing\n<code>!media off</code> \u2014 disable",
          );
        }
        return;
      }

      case "format": {
        if (argStr === "on") {
          this.formatEnabled = true;
          await this.bridge.sendMessage("HTML formatting enabled.");
        } else if (argStr === "off") {
          this.formatEnabled = false;
          await this.bridge.sendMessage("Formatting disabled. Raw text mode.");
        } else {
          await this.bridge.sendMessage(
            `<b>Format settings</b>\n\nFormatting: ${this.formatEnabled ? "on" : "off"}\n\n` +
            "<code>!format on</code> \u2014 convert markdown to HTML\n<code>!format off</code> \u2014 send raw text",
          );
        }
        return;
      }

      case "harness":
      case "switch": {
        const HARNESS_ALIASES: Record<string, ActiveHarness> = {
          claude: "claude-code",
          "claude-code": "claude-code",
          opencode: "opencode",
          oc: "opencode",
          gemini: "gemini-cli",
          "gemini-cli": "gemini-cli",
          codex: "codex-cli",
          "codex-cli": "codex-cli",
          auto: "auto",
        };
        if (!argStr) {
          // Send inline keyboard for interactive selection
          const keyboard = new InlineKeyboard()
            .text("Claude Code", "harness:claude-code")
            .text("OpenCode", "harness:opencode")
            .row()
            .text("Gemini CLI", "harness:gemini-cli")
            .text("Codex CLI", "harness:codex-cli")
            .row()
            .text("Auto", "harness:auto");

          await this.bridge.sendMessageWithKeyboard(
            `<b>Active harness:</b> ${this.harnessLabel(this.activeHarness)}\n\nSelect a harness:`,
            keyboard,
          );
          return;
        }
        const target = HARNESS_ALIASES[argStr.toLowerCase()];
        if (!target) {
          await this.bridge.sendMessage(
            `Unknown harness: "${argStr}"\n\nAvailable: claude, opencode, gemini, auto`,
          );
          return;
        }
        this.activeHarness = target;
        this.saveState();
        const desc =
          target === "auto"
            ? "Intent-based routing restored \u2014 workspace tasks \u2192 Gemini, coding tasks \u2192 Claude Code."
            : `All messages will now route to <b>${this.harnessLabel(target)}</b> until you change it with <code>!harness auto</code>.`;
        await this.bridge.sendMessage(
          `Switched to <b>${this.harnessLabel(target)}</b>\n\n${desc}`,
        );
        return;
      }

      case "help":
      case "commands":
        await this.bridge.sendMessage(
          "<b>Telegram HQ Commands</b>\n\n" +
          "<b>Harness</b>\n" +
          "<code>!harness</code> \u2014 Show harness picker\n" +
          "<code>!harness claude</code> \u2014 Pin to Claude Code\n" +
          "<code>!harness opencode</code> \u2014 Pin to OpenCode\n" +
          "<code>!harness gemini</code> \u2014 Pin to Gemini CLI\n" +
          "<code>!harness auto</code> \u2014 Auto-route by intent\n\n" +
          "<b>Chat</b>\n" +
          "<code>!reset</code> \u2014 Start new conversation\n" +
          "<code>!model &lt;name&gt;</code> \u2014 Set model by ID\n" +
          "<code>!opus</code> / <code>!sonnet</code> / <code>!haiku</code> \u2014 Quick Claude switch\n\n" +
          "<b>HQ</b>\n" +
          "<code>!status</code> \u2014 Agent / active task status\n" +
          "<code>!memory</code> \u2014 Show memory\n" +
          "<code>!search &lt;query&gt;</code> \u2014 Search vault\n" +
          "<code>!threads</code> \u2014 List conversation threads\n\n" +
          "<b>Media</b>\n" +
          "<code>!media [on|off]</code> \u2014 Toggle AI media processing\n\n" +
          "<b>Interactive</b>\n" +
          "<code>!poll Q | Opt1 | Opt2</code> \u2014 Create a poll\n" +
          "<code>!location &lt;lat&gt; &lt;lng&gt;</code> \u2014 Send location\n\n" +
          "<b>Message Ops</b>\n" +
          "<code>!delete</code> \u2014 Delete last bot message\n" +
          "<code>!edit &lt;text&gt;</code> \u2014 Edit last bot message\n\n" +
          "<b>Settings</b>\n" +
          "<code>!voice [on|off]</code> \u2014 Toggle voice note replies\n" +
          "<code>!format [on|off]</code> \u2014 Toggle HTML formatting\n" +
          "<code>!sessions</code> \u2014 List active harness sessions\n" +
          "<code>!help</code> \u2014 This message",
        );
        return;

      case "diagram":
      case "draw": {
        if (!argStr) {
          await this.bridge.sendMessage(
            "<b>Diagram Commands</b>\n\n" +
            '<code>!diagram flow "Step 1" "Step 2" "Decision?" "Done"</code>\n' +
            '<code>!diagram create --title "Name" --nodes "A,B,C" --edges "A&gt;B,B&gt;C"</code>\n' +
            "<code>!diagram map [path]</code>\n" +
            "<code>!diagram deps [path]</code>",
          );
          return;
        }

        try {
          await this.bridge.sendChatAction("typing");
          const output = execSync(`hq diagram ${argStr}`, {
            timeout: 30_000,
            encoding: "utf-8",
            env: { ...process.env, FORCE_COLOR: "0" },
          });

          const fileMatch = output.match(/\[FILE:\s*([^\]|]+?)(?:\s*\|\s*([^\]]+?))?\s*\]/);
          if (fileMatch) {
            const filePath = fileMatch[1].trim();
            if (existsSync(filePath)) {
              const buffer = readFileSync(filePath);
              await this.bridge.sendPhoto(Buffer.from(buffer), fileMatch[2]?.trim() ?? "diagram");
              return;
            }
          }

          const cleanOutput = output
            .replace(/\[FILE:[^\]]+\]/g, "")
            .replace(/\n{3,}/g, "\n")
            .trim();
          await this.bridge.sendMessage(
            cleanOutput.substring(0, 2000) || "Diagram generated.",
            { parseMode: "HTML" },
          );
        } catch (err: any) {
          const errMsg = err.stderr?.toString().trim() || err.message || "Unknown error";
          await this.bridge.sendMessage(`Diagram error: ${errMsg.substring(0, 500)}`);
        }
        return;
      }

      default:
        await this.bridge.sendMessage(`Unknown command: <code>!${cmd}</code>. Try <code>!help</code>.`);
        return;
    }

    // Execute relay command
    if (command) {
      await this.executeRelayCommand(command, args);
    }
  }

  private async handleVoiceCommand(argStr: string): Promise<void> {
    if (argStr === "on") {
      if (!this.voiceHandler || !this.voiceHandler.canSynthesize) {
        await this.bridge.sendMessage(
          "Voice reply not available \u2014 set OPENAI_API_KEY in .env.local to enable TTS.",
        );
      } else {
        this.voiceReplyEnabled = true;
        await this.bridge.sendMessage("Voice reply enabled. I'll respond with voice notes.");
      }
    } else if (argStr === "off") {
      this.voiceReplyEnabled = false;
      await this.bridge.sendMessage("Voice reply disabled. Back to text mode.");
    } else {
      const voiceStatus = this.voiceReplyEnabled ? "on" : "off";
      const voiceAvail = this.voiceHandler ? "available" : "not configured (set GROQ_API_KEY)";
      await this.bridge.sendMessage(
        `<b>Voice settings</b>\n\nTranscription: ${voiceAvail}\nReply mode: ${voiceStatus}\n\n` +
        "<code>!voice on</code> \u2014 respond with voice notes\n<code>!voice off</code> \u2014 respond with text",
      );
    }
  }

  private async executeRelayCommand(
    command: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    try {
      console.log(`[relay-telegram] Sending command to relay: ${command}`);
      const result = await new Promise<string>((resolve, reject) => {
        const requestId = `tg-cmd-${Date.now()}`;
        const unsub = this.relay.on<CmdResultMessage>("cmd:result", (cmdMsg) => {
          if (cmdMsg.requestId === requestId) {
            unsub();
            if (cmdMsg.success) {
              resolve(cmdMsg.output ?? "Done.");
            } else {
              reject(new Error(cmdMsg.error ?? "Command failed"));
            }
          }
        });

        this.relay.send({
          type: "cmd:execute",
          command,
          args,
          requestId,
        });

        setTimeout(() => {
          unsub();
          reject(new Error("Command timeout"));
        }, 10_000);
      });

      await this.sendChunked(result);
    } catch (err) {
      console.error("[relay-telegram] Command error:", err);
      await this.bridge.sendMessage(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async processQueue(): Promise<void> {
    while (this.messageQueue.length > 0) {
      const queuedMsg = this.messageQueue.shift()!;
      const content = queuedMsg.content.trim();

      if (queuedMsg.mediaType && queuedMsg.mediaType !== "audio") {
        await this.handleMediaMessage(queuedMsg);
        continue;
      }

      if (!content) continue;

      console.log(`[relay-telegram] Processing queued message: "${content.substring(0, 40)}"`);

      if (content.startsWith("!")) {
        await this.handleBangCommand(content, queuedMsg);
      } else if (this.activeHarness !== "auto") {
        await this.handleLocalHarness(content, this.activeHarness, queuedMsg);
      } else {
        await this.handleChat(content, queuedMsg);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // LOCAL HARNESS (direct CLI execution)
  // ══════════════════════════════════════════════════════════════

  private async handleLocalHarness(
    content: string,
    harness: "claude-code" | "opencode" | "gemini-cli" | "codex-cli",
    sourceMsg?: TelegramMessage,
  ): Promise<void> {
    this.processing = true;
    const label = this.harnessLabel(harness);
    const sessionId = `tg-${Date.now()}`;

    // Prepend reply context so the harness knows what the user is replying to
    let enrichedContent = content;
    if (sourceMsg?.replyContent) {
      const preview = sourceMsg.replyContent.slice(0, 200);
      enrichedContent = `[Replying to: "${preview}"]\n\n${content}`;
    }

    let typingInterval: ReturnType<typeof setInterval> | null = null;
    try {
      await this.bridge.sendChatAction("typing");
      typingInterval = setInterval(async () => {
        try { await this.bridge.sendChatAction("typing"); } catch { /* non-critical */ }
      }, TYPING_KEEPALIVE_MS);

      console.log(`[relay-telegram] SessionOrchestrator: spawning ${label} session ${sessionId}`);

      await this.sessionOrchestrator.run(sessionId, harness, enrichedContent, {
        onStatusUpdate: (_session, message) => {
          console.log(`[relay-telegram] Session ${sessionId}: ${message}`);
          this.bridge.sendMessage(message, { parseMode: "HTML" }).catch(console.error);
        },
        onResult: (_session, result) => {
          if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
          const formatted = this.formatEnabled ? formatForTelegram(result) : result;
          this.sendChunked(formatted).catch(console.error);
        },
        onFailed: (_session, error) => {
          if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
          console.error(`[relay-telegram] Session ${sessionId} failed: ${error}`);
          this.bridge
            .sendMessage(`<i>${label} failed: ${error}</i>`)
            .catch(console.error);
        },
      });
    } catch (err) {
      if (typingInterval) clearInterval(typingInterval);
      console.error(`[relay-telegram] Orchestrator error for session ${sessionId}:`, err);
      await this.bridge.sendMessage(
        `<i>${label} error: ${err instanceof Error ? err.message : String(err)}</i>`,
      );
    } finally {
      if (typingInterval) clearInterval(typingInterval);
      this.processing = false;
    }
  }

  // ══════════════════════════════════════════════════════════════
  // STATE PERSISTENCE
  // ══════════════════════════════════════════════════════════════

  private loadState(): void {
    try {
      const raw = readFileSync(this.stateFile, "utf8");
      const data = JSON.parse(raw) as { activeHarness?: string };
      const valid: ActiveHarness[] = ["auto", "claude-code", "opencode", "gemini-cli", "codex-cli"];
      if (data.activeHarness && valid.includes(data.activeHarness as ActiveHarness)) {
        this.activeHarness = data.activeHarness as ActiveHarness;
        console.log(`[relay-telegram] Loaded persisted harness: ${this.activeHarness}`);
      }
    } catch {
      // File doesn't exist yet
    }
  }

  private saveState(): void {
    try {
      writeFileSync(
        this.stateFile,
        JSON.stringify({ activeHarness: this.activeHarness }, null, 2),
        "utf8",
      );
    } catch (err) {
      console.error("[relay-telegram] Failed to save state:", err);
    }
  }

  private harnessLabel(h: ActiveHarness): string {
    switch (h) {
      case "claude-code": return "Claude Code";
      case "opencode": return "OpenCode";
      case "gemini-cli": return "Gemini CLI";
      case "codex-cli": return "Codex CLI";
      case "auto": return "Auto (intent-based)";
    }
  }

  // ══════════════════════════════════════════════════════════════
  // DELEGATION
  // ══════════════════════════════════════════════════════════════

  private async handleDelegation(
    content: string,
    harness: "gemini-cli" | "claude-code" | "opencode" | "any",
    role?: string,
  ): Promise<void> {
    this.processing = true;
    const hLabel =
      harness === "gemini-cli" ? "Gemini CLI"
        : harness === "claude-code" ? "Claude Code"
          : harness === "opencode" ? "OpenCode"
            : "HQ";

    try {
      await this.bridge.sendMessage(`<i>Routing to ${hLabel}...</i>`);

      const roleHint = role ? ` role=${role}` : "";
      const instruction =
        `[TELEGRAM_ORCHESTRATION targetHarness=${harness}${roleHint}]\n\n` +
        `<user_message>\n${content}\n</user_message>\n\n` +
        `Use the delegate_to_relay tool to handle the user's request above via ${harness}` +
        `${role ? ` with role="${role}"` : ""}. Return the complete response to the user.`;

      const jobId = await new Promise<string>((resolve, reject) => {
        const requestId = `tg-job-${Date.now()}`;
        const unsub = this.relay.on("job:submitted", (msg: any) => {
          if (msg.requestId === requestId) {
            unsub();
            resolve(msg.jobId);
          }
        });
        const unsubErr = this.relay.on("error", (msg: any) => {
          if (msg.requestId === requestId) {
            unsubErr();
            reject(new Error(msg.message ?? "Job submit failed"));
          }
        });
        this.relay.send({
          type: "job:submit",
          instruction,
          jobType: "background",
          requestId,
        } as any);
        setTimeout(() => {
          unsub();
          unsubErr();
          reject(new Error("Job submit timeout \u2014 agent may be offline"));
        }, 15_000);
      });

      console.log(`[relay-telegram] Job submitted: ${jobId} \u2192 ${harness}`);
      this.activeJobId = jobId;
      this.activeJobLabel = hLabel;
      this.activeJobResultDelivered = false;

      await this.bridge.sendMessage(
        `<i>Task queued (job: <code>${jobId.slice(-8)}</code>). ${hLabel} will respond shortly. Type !status for updates.</i>`,
      );

      // 10-min failsafe
      setTimeout(async () => {
        if (this.activeJobId === jobId && !this.activeJobResultDelivered) {
          console.warn(`[relay-telegram] Job ${jobId} timed out \u2014 falling back to direct chat`);
          this.activeJobId = null;
          this.activeJobLabel = null;
          this.activeTaskIds.clear();
          this.processing = false;
          await this.bridge.sendMessage(`<i>${hLabel} didn't respond in time. Answering directly...</i>`);
          await this.handleChat(content);
        }
      }, 10 * 60 * 1000);
    } catch (err) {
      console.error("[relay-telegram] Delegation setup error:", err);
      this.activeJobId = null;
      this.activeJobLabel = null;
      this.activeTaskIds.clear();
      this.processing = false;
      await this.bridge.sendMessage(`<i>${hLabel} unavailable \u2014 answering directly...</i>`);
      await this.handleChat(content);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // VAULT EVENTS
  // ══════════════════════════════════════════════════════════════

  private async handleVaultEvent(event: string, data?: any): Promise<void> {
    const filePath: string = data?.path ?? data?.filePath ?? "";
    const taskIdMatch = filePath.match(/task-([^/]+?)\.md$/);
    const taskId = taskIdMatch?.[1] ?? null;
    const jobIdMatch = filePath.match(/job-([^/]+?)\.md$/);
    const fileJobId = jobIdMatch ? `job-${jobIdMatch[1]}` : null;

    switch (event) {
      case "task:created":
        if (this.activeJobId && taskId) {
          this.activeTaskIds.add(taskId);
          console.log(`[relay-telegram] Task created: ${taskId} for job ${this.activeJobId}`);
        }
        break;

      case "task:claimed":
        if (this.activeJobId && taskId && this.activeTaskIds.has(taskId)) {
          const claimedBy = data?.claimedBy ?? (harnessFromPath(filePath) ?? "a bot");
          await this.bridge.sendMessage(`<i>${claimedBy} is now working on your request...</i>`);
        }
        break;

      case "task:completed":
        if (
          this.activeJobId &&
          taskId &&
          this.activeTaskIds.has(taskId) &&
          !this.activeJobResultDelivered
        ) {
          console.log(`[relay-telegram] Task completed: ${taskId} \u2014 fetching result`);
          const result = await this.fetchTaskResult(taskId);
          if (result) {
            this.activeJobResultDelivered = true;
            this.activeJobId = null;
            this.activeJobLabel = null;
            this.activeTaskIds.clear();
            this.processing = false;
            await this.sendChunked(result);
          }
        }
        break;

      case "job:completed":
        if (
          this.activeJobId &&
          fileJobId === this.activeJobId &&
          !this.activeJobResultDelivered
        ) {
          console.log(`[relay-telegram] Job completed: ${fileJobId} \u2014 fetching result`);
          const result = await this.fetchJobResult(fileJobId);
          if (result) {
            this.activeJobResultDelivered = true;
            this.activeJobId = null;
            this.activeJobLabel = null;
            this.activeTaskIds.clear();
            this.processing = false;
            await this.sendChunked(result);
          }
        }
        break;

      case "job:failed":
        if (
          this.activeJobId &&
          fileJobId === this.activeJobId &&
          !this.activeJobResultDelivered
        ) {
          this.activeJobResultDelivered = true;
          this.activeJobId = null;
          this.activeJobLabel = null;
          this.activeTaskIds.clear();
          this.processing = false;
          await this.bridge.sendMessage("<i>The delegated task failed. Try again or rephrase.</i>");
        }
        break;
    }
  }

  private fetchTaskResult(taskId: string): Promise<string | null> {
    return new Promise((resolve) => {
      const requestId = `tg-tres-${Date.now()}`;
      const unsub = this.relay.on<CmdResultMessage>("cmd:result", (msg) => {
        if (msg.requestId === requestId) {
          unsub();
          const out = msg.output ?? null;
          resolve(out && out !== "__pending__" ? out : null);
        }
      });
      this.relay.send({
        type: "cmd:execute",
        command: "task-result",
        args: { taskId },
        requestId,
      });
      setTimeout(() => { unsub(); resolve(null); }, 8_000);
    });
  }

  private fetchJobResult(jobId: string): Promise<string | null> {
    return new Promise((resolve) => {
      const requestId = `tg-jres-${Date.now()}`;
      const unsub = this.relay.on<CmdResultMessage>("cmd:result", (msg) => {
        if (msg.requestId === requestId) {
          unsub();
          const out = msg.output ?? null;
          resolve(out && out !== "__pending__" ? out : null);
        }
      });
      this.relay.send({
        type: "cmd:execute",
        command: "job-result",
        args: { jobId },
        requestId,
      });
      setTimeout(() => { unsub(); resolve(null); }, 8_000);
    });
  }

  // ══════════════════════════════════════════════════════════════
  // CHAT
  // ══════════════════════════════════════════════════════════════

  private async handleChat(
    content: string,
    sourceMsg?: TelegramMessage,
  ): Promise<void> {
    this.processing = true;
    const requestId = `tg-chat-${Date.now()}`;

    // Prepend reply context so the agent knows what the user is replying to
    let enrichedContent = content;
    if (sourceMsg?.replyContent) {
      const preview = sourceMsg.replyContent.slice(0, 200);
      enrichedContent = `[Replying to: "${preview}"]\n\n${content}`;
    }

    let typingInterval: ReturnType<typeof setInterval> | null = null;
    try {
      await this.bridge.sendChatAction("typing");
      typingInterval = setInterval(async () => {
        try { await this.bridge.sendChatAction("typing"); } catch { /* non-critical */ }
      }, TYPING_KEEPALIVE_MS);
    } catch { /* non-critical */ }

    try {
      console.log(
        `[relay-telegram] Sending chat to relay: requestId=${requestId}, threadId=${this.threadId ?? "new"}`,
      );

      let buffer = "";
      let deltaCount = 0;

      const finalMsg = await new Promise<ChatFinalMessage>((resolve, reject) => {
        const unsub1 = this.relay.on<ChatDeltaMessage>("chat:delta", (deltaMsg) => {
          if (deltaMsg.requestId === requestId) {
            deltaCount++;
            buffer += deltaMsg.delta;
            if (deltaCount % 20 === 0) {
              console.log(
                `[relay-telegram] Streaming: ${deltaCount} deltas, ${buffer.length} chars`,
              );
            }
          }
        });

        const unsub2 = this.relay.on<ChatFinalMessage>("chat:final", (msg) => {
          if (msg.requestId === requestId) {
            unsub1(); unsub2(); unsub3();
            resolve(msg);
          }
        });

        const unsub3 = this.relay.on("error", (errMsg) => {
          if ((errMsg as any).requestId === requestId) {
            unsub1(); unsub2(); unsub3();
            reject(new Error((errMsg as any).message ?? "Unknown relay error"));
          }
        });

        try {
          this.relay.send({
            type: "chat:send",
            content: enrichedContent,
            threadId: this.threadId ?? undefined,
            requestId,
            modelOverride: this.modelOverride,
          });
        } catch (sendErr) {
          unsub1(); unsub2(); unsub3();
          reject(sendErr);
          return;
        }

        setTimeout(() => {
          unsub1(); unsub2(); unsub3();
          reject(new Error("Request timed out (10 min)"));
        }, 10 * 60 * 1000);
      });

      // Save thread ID
      if (finalMsg.threadId && !this.threadId) {
        this.threadId = finalMsg.threadId;
        console.log(`[relay-telegram] Thread ID saved: ${this.threadId}`);
      }

      // Stop typing
      if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }

      // Send response
      const responseText = finalMsg.content || buffer;
      console.log(`[relay-telegram] Response ready: ${responseText.length} chars`);

      if (responseText.trim()) {
        if (this.voiceReplyEnabled && this.voiceHandler) {
          try {
            console.log("[relay-telegram] Synthesizing voice reply...");
            await this.bridge.sendChatAction("upload_voice");
            const audioBuffer = await this.voiceHandler.synthesize(responseText);
            await this.bridge.sendVoiceNote(audioBuffer);
          } catch (err) {
            console.error("[relay-telegram] TTS failed, falling back to text:", err);
            await this.sendFormattedResponse(responseText, sourceMsg);
          }
        } else {
          await this.sendFormattedResponse(responseText, sourceMsg);
        }
      } else {
        console.warn("[relay-telegram] Empty response from relay");
        await this.bridge.sendMessage(
          "(No response from agent \u2014 the relay server may not have an active agent or LLM backend configured.)",
        );
      }
    } catch (err) {
      console.error("[relay-telegram] Chat error:", err);
      if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
      await this.bridge.sendMessage(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (typingInterval) clearInterval(typingInterval);
      this.processing = false;
    }
  }

  // ══════════════════════════════════════════════════════════════
  // SEND HELPERS
  // ══════════════════════════════════════════════════════════════

  private async sendFormattedResponse(
    text: string,
    sourceMsg?: TelegramMessage,
  ): Promise<void> {
    const formatted = this.formatEnabled ? formatForTelegram(text) : text;
    await this.sendChunked(formatted, sourceMsg);
  }

  private async sendReply(text: string, sourceMsg?: TelegramMessage): Promise<void> {
    const formatted = this.formatEnabled ? formatForTelegram(text) : text;
    const msgId = await this.bridge.sendMessage(formatted, {
      replyTo: sourceMsg?.id,
    });
    if (msgId) this.lastSentMsgId = msgId;
  }

  private async extractAndSendFiles(text: string): Promise<string> {
    const FILE_RE = /\[FILE:\s*([^\]|]+?)(?:\s*\|\s*([^\]]+?))?\s*\]/g;
    const filePaths: Array<{ path: string; name: string }> = [];
    const cleanText = text.replace(FILE_RE, (_match, rawPath, rawName) => {
      filePaths.push({
        path: rawPath.trim(),
        name: rawName?.trim() ?? basename(rawPath.trim()),
      });
      return "";
    }).replace(/\n{3,}/g, "\n\n").trim();

    for (const f of filePaths) {
      try {
        if (!existsSync(f.path)) {
          console.warn(`[telegram] File not found, skipping: ${f.path}`);
          continue;
        }
        const buffer = readFileSync(f.path);
        const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
        if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) {
          await this.bridge.sendPhoto(Buffer.from(buffer), f.name);
        } else if (["wav", "mp3", "ogg", "m4a", "aac", "flac"].includes(ext)) {
          // Convert to OGG Opus for proper Telegram voice note display
          const oggBuffer = convertToOgg(f.path);
          await this.bridge.sendVoiceNote(oggBuffer);
        } else {
          await this.bridge.sendDocument(Buffer.from(buffer), f.name);
        }
        console.log(`[telegram] Sent file: ${f.name}`);
      } catch (err: any) {
        console.error(`[telegram] Failed to send file ${f.path}:`, err.message);
      }
    }

    return cleanText;
  }

  private async sendChunked(
    text: string,
    sourceMsg?: TelegramMessage,
  ): Promise<void> {
    // Extract and send any [FILE:] attachments
    text = await this.extractAndSendFiles(text);

    if (text.length <= MAX_CHUNK_SIZE) {
      const msgId = await this.bridge.sendMessage(text, {
        replyTo: sourceMsg?.id,
      });
      if (msgId) {
        this.lastSentMsgId = msgId;
        this.bridge.cacheMessage(msgId, text);
      }
      return;
    }

    // Split at paragraph boundaries
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= MAX_CHUNK_SIZE) {
        chunks.push(remaining);
        break;
      }

      let splitAt = remaining.lastIndexOf("\n\n", MAX_CHUNK_SIZE);
      if (splitAt < MAX_CHUNK_SIZE / 2) {
        splitAt = remaining.lastIndexOf("\n", MAX_CHUNK_SIZE);
      }
      if (splitAt < MAX_CHUNK_SIZE / 2) {
        splitAt = remaining.lastIndexOf(" ", MAX_CHUNK_SIZE);
      }
      if (splitAt < MAX_CHUNK_SIZE / 2) {
        splitAt = MAX_CHUNK_SIZE;
      }

      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt).trimStart();
    }

    console.log(`[relay-telegram] Sending ${chunks.length} chunks (total: ${text.length} chars)`);

    for (let i = 0; i < chunks.length; i++) {
      const msgId = await this.bridge.sendMessage(chunks[i], {
        replyTo: i === 0 ? sourceMsg?.id : undefined,
      });
      if (msgId) {
        this.lastSentMsgId = msgId;
        // Cache the last chunk as it's most representative of the response
        if (i === chunks.length - 1) this.bridge.cacheMessage(msgId, chunks[i]);
      }
    }
  }
}

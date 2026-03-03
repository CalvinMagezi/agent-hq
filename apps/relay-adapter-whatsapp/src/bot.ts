/**
 * RelayWhatsAppBot — Routes WhatsApp self-chat messages through the relay server.
 *
 * Supports all WhatsApp message types: text, media (images/video/docs/stickers),
 * voice notes, locations, contacts, polls, reactions, forwarding, editing, deletion.
 * AI vision for received images, WhatsApp-native formatting, auto-reactions.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { basename } from "path";
import { LocalHarness } from "./localHarness.js";
import { RelayClient } from "@repo/agent-relay-protocol";
import type {
  RelayClientConfig,
  CmdResultMessage,
  ChatDeltaMessage,
  ChatFinalMessage,
} from "@repo/agent-relay-protocol";
import type { proto } from "@whiskeysockets/baileys";
import type { WhatsAppBridge, WhatsAppMessage } from "./whatsapp.js";
import type { WhatsAppGuard } from "./guard.js";
import type { VoiceHandler } from "./voice.js";
import type { MediaHandler } from "./media.js";
import { detectIntent } from "./orchestrator.js";
import { formatForWhatsApp } from "./formatter.js";
import { SessionOrchestrator } from "./sessionOrchestrator.js";

type ActiveHarness = "auto" | "claude-code" | "opencode" | "gemini-cli";

/** Max chars per WhatsApp message for readability. */
const MAX_CHUNK_SIZE = 4000;

/** Extract a human-readable harness label from a delegation task file path. */
function harnessFromPath(filePath: string): string | null {
  if (filePath.includes("gemini")) return "Gemini";
  if (filePath.includes("claude")) return "Claude Code";
  if (filePath.includes("opencode")) return "OpenCode";
  return null;
}

/** Typing indicator keepalive interval (Baileys composing expires ~25s). */
const TYPING_KEEPALIVE_MS = 20_000;

export interface RelayWhatsAppBotConfig {
  guard: WhatsAppGuard;
  bridge: WhatsAppBridge;
  relayHost?: string;
  relayPort?: number;
  apiKey?: string;
  debug?: boolean;
  /** Optional voice handler for transcription + TTS. */
  voiceHandler?: VoiceHandler;
  /** Optional media handler for downloads, vision, stickers. */
  mediaHandler?: MediaHandler;
  /** Auto-process received media with AI (default: true). */
  mediaAutoProcess?: boolean;
  /** Path to JSON file for persisting bot state (harness preference). Default: .whatsapp-state.json */
  stateFile?: string;
}

export class RelayWhatsAppBot {
  private relay: RelayClient;
  private bridge: WhatsAppBridge;
  private guard: WhatsAppGuard;
  private voiceHandler: VoiceHandler | null;
  private mediaHandler: MediaHandler | null;
  private voiceReplyEnabled = false;
  private mediaAutoProcess: boolean;
  private formatEnabled = true;
  private processedMessages = new Set<string>();
  private threadId: string | null = null;
  private modelOverride: string | undefined;
  private activeHarness: ActiveHarness = "auto";
  private stateFile: string;
  private localHarness: LocalHarness;
  private sessionOrchestrator: SessionOrchestrator;
  private processing = false;
  private messageQueue: WhatsAppMessage[] = [];

  /** Active orchestration job tracking */
  private activeJobId: string | null = null;
  private activeJobLabel: string | null = null;
  private activeJobResultDelivered = false;
  /** Track task IDs associated with the active job. */
  private activeTaskIds = new Set<string>();

  /** Track last received/sent messages for !react, !delete, !edit, !forward, !sticker */
  private lastReceivedMsg: WhatsAppMessage | null = null;
  private lastSentMsgKey: proto.IMessageKey | null = null;

  constructor(config: RelayWhatsAppBotConfig) {
    this.guard = config.guard;
    this.bridge = config.bridge;
    this.voiceHandler = config.voiceHandler ?? null;
    this.mediaHandler = config.mediaHandler ?? null;
    this.mediaAutoProcess = config.mediaAutoProcess ?? true;
    this.stateFile = config.stateFile ?? ".whatsapp-state.json";
    this.loadState();
    this.localHarness = new LocalHarness(".whatsapp-harness-sessions.json");
    this.sessionOrchestrator = new SessionOrchestrator(this.localHarness);

    const relayConfig: RelayClientConfig = {
      host: config.relayHost,
      port: config.relayPort,
      apiKey: config.apiKey ?? "",
      clientId: "whatsapp-relay-adapter",
      clientType: "whatsapp",
      autoReconnect: true,
      debug: config.debug,
    };

    this.relay = new RelayClient(relayConfig);
  }

  async start(): Promise<void> {
    // Connect to relay server first
    console.log("[relay-whatsapp] Connecting to relay server...");
    await this.relay.connect();
    console.log("[relay-whatsapp] Connected to relay server");

    // Subscribe to vault events for live orchestration status
    this.relay.send({ type: "system:subscribe", events: ["job:*", "task:*"] });
    this.relay.on("system:event", (eventMsg: any) => {
      this.handleVaultEvent(eventMsg.event, eventMsg.data).catch(console.error);
    });

    // Register message handler on the WhatsApp bridge
    this.bridge.onMessage((msg) => this.handleMessage(msg));

    // Register message update handler for poll votes etc.
    this.bridge.onMessageUpdate((update) => {
      if (update.type === "poll_vote") {
        const votes = update.data?.votes;
        if (votes) {
          const summary = votes
            .map((v: any) => `${v.name}: ${v.voters?.length ?? 0} votes`)
            .join("\n");
          this.bridge
            .sendMessage(`*Poll Results*\n\n${summary}`)
            .catch(console.error);
        }
      }
    });

    // Start the WhatsApp bridge
    await this.bridge.start();
    console.log(
      "[relay-whatsapp] WhatsApp bridge started — listening for self-chat messages",
    );
  }

  async stop(): Promise<void> {
    this.relay.disconnect();
    await this.bridge.stop();
    if (this.mediaHandler) {
      this.mediaHandler.destroy();
    }
    console.log("[relay-whatsapp] Bot stopped");
  }

  private async handleMessage(msg: WhatsAppMessage): Promise<void> {
    console.log(
      `[relay-whatsapp] handleMessage called: id=${msg.id}, content="${msg.content.substring(0, 60)}", fromMe=${msg.fromMe}, mediaType=${msg.mediaType ?? "none"}`,
    );

    // Dedup
    if (this.processedMessages.has(msg.id)) {
      console.log(`[relay-whatsapp] Skipping duplicate message: ${msg.id}`);
      return;
    }
    this.processedMessages.add(msg.id);
    if (this.processedMessages.size > 200) {
      const first = this.processedMessages.values().next().value;
      if (first) this.processedMessages.delete(first);
    }

    // Guard check (redundant — bridge already filters, but defense-in-depth)
    if (!this.guard.isAllowedChat(msg.chatJid)) {
      console.log(
        `[relay-whatsapp] Guard blocked message from: ${msg.chatJid}`,
      );
      return;
    }

    // Mark the message as read early so UI shows it
    await this.bridge.markRead(msg);

    // Track last received message
    this.lastReceivedMsg = msg;

    // ── Reaction messages — log but don't process as chat ─────
    if (msg.reaction) {
      console.log(
        `[relay-whatsapp] Reaction received: ${msg.reaction.emoji} on ${msg.reaction.targetId}`,
      );
      return;
    }

    // ── Auto-react to acknowledge receipt ─────────────────────
    if (msg.rawMessage?.key) {
      await this.bridge.sendReaction(msg.rawMessage.key, "👁️");
    }

    // ── Voice note handling ───────────────────────────────────
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
        await this.sendReply(
          "Received a voice note but failed to download the audio.",
          msg,
        );
        return;
      }
      try {
        console.log("[relay-whatsapp] Transcribing voice note...");
        await this.bridge.sendRecording();
        const transcript = await this.voiceHandler.transcribe(msg.audioBuffer);
        if (!transcript) {
          await this.sendReply(
            "I received your voice note but couldn't make out what was said.",
            msg,
          );
          return;
        }
        console.log(
          `[relay-whatsapp] Voice note transcribed: "${transcript.substring(0, 80)}"`,
        );
        await this.handleChat(`[Voice note]: ${transcript}`, msg);
        await this.processQueue();
        return;
      } catch (err) {
        console.error("[relay-whatsapp] Transcription failed:", err);
        await this.sendReply(
          `Failed to transcribe voice note: ${err instanceof Error ? err.message : String(err)}`,
          msg,
        );
        return;
      }
    }

    // ── Media message handling ────────────────────────────────
    if (msg.mediaType && msg.mediaType !== "audio") {
      await this.handleMediaMessage(msg);
      await this.processQueue();
      return;
    }

    // ── Location message ─────────────────────────────────────
    if (msg.location) {
      const { lat, lng, name, address } = msg.location;
      const locText = name
        ? `[Location shared]: ${name}${address ? ` — ${address}` : ""} (${lat.toFixed(6)}, ${lng.toFixed(6)})`
        : `[Location shared]: ${lat.toFixed(6)}, ${lng.toFixed(6)}`;
      await this.handleChat(locText, msg);
      await this.processQueue();
      return;
    }

    // ── Contact message ──────────────────────────────────────
    if (msg.contactVcard) {
      const contactText = `[Contact shared]: ${msg.contactName ?? "Unknown contact"}`;
      await this.handleChat(contactText, msg);
      await this.processQueue();
      return;
    }

    // ── Poll message ─────────────────────────────────────────
    if (msg.pollName) {
      const pollText = `[Poll received]: ${msg.pollName}\nOptions: ${msg.pollOptions?.join(", ")}`;
      await this.handleChat(pollText, msg);
      await this.processQueue();
      return;
    }

    const content = msg.content.trim();
    if (!content) {
      console.log("[relay-whatsapp] Empty content, skipping");
      return;
    }

    // Queue message if already processing
    if (this.processing) {
      console.log(
        `[relay-whatsapp] Already processing — queuing message: "${content.substring(0, 40)}"`,
      );
      this.messageQueue.push(msg);
      return;
    }

    // ── ! Commands ───────────────────────────────────────────
    if (content.startsWith("!")) {
      console.log(`[relay-whatsapp] Processing command: ${content}`);
      await this.handleBangCommand(content, msg);
      return;
    }

    // ── Harness routing ──────────────────────────────────────
    if (this.activeHarness !== "auto") {
      console.log(
        `[relay-whatsapp] Local harness ${this.activeHarness}: "${content.substring(0, 60)}"`,
      );
      await this.handleLocalHarness(content, this.activeHarness);
    } else {
      // Intent-based auto routing
      const { intent, harness, role } = detectIntent(content);
      console.log(`[relay-whatsapp] Intent: ${intent}, harness: ${harness}, role: ${role}`);

      if (intent !== "general" && !this.modelOverride) {
        console.log(
          `[relay-whatsapp] Delegating to ${harness} (${role}): "${content.substring(0, 60)}"`,
        );
        await this.handleDelegation(content, harness, role);
      } else {
        console.log(
          `[relay-whatsapp] Processing chat message: "${content.substring(0, 60)}"`,
        );
        await this.handleChat(content, msg);
      }
    }

    // Process any queued messages
    await this.processQueue();
  }

  // ══════════════════════════════════════════════════════════════
  // MEDIA HANDLING
  // ══════════════════════════════════════════════════════════════

  private async handleMediaMessage(msg: WhatsAppMessage): Promise<void> {
    const { mediaType, mediaBuffer, mediaMimeType, mediaFilename, mediaSize } = msg;
    const sizeStr = this.mediaHandler?.formatSize(mediaSize ?? 0) ?? `${mediaSize ?? 0}B`;

    if (!mediaBuffer) {
      await this.sendReply(
        `Received ${mediaType} but failed to download it.`,
        msg,
      );
      return;
    }

    switch (mediaType) {
      case "image": {
        if (this.mediaAutoProcess && this.mediaHandler?.canDescribe) {
          await this.bridge.sendTyping();
          const caption = msg.content ? `\n\nCaption: "${msg.content}"` : "";
          const prompt = msg.content
            ? `Describe this image. The sender included this caption: "${msg.content}"`
            : undefined;
          const description = await this.mediaHandler.describeImage(
            mediaBuffer,
            prompt,
          );
          await this.handleChat(
            `[Image received (${sizeStr})]${caption}\n\nAI description: ${description}`,
            msg,
          );
        } else {
          const caption = msg.content ? ` — Caption: "${msg.content}"` : "";
          await this.sendReply(
            `Image received (${sizeStr})${caption}. AI vision not available.`,
            msg,
          );
        }
        break;
      }

      case "video": {
        const caption = msg.content ? ` — Caption: "${msg.content}"` : "";
        await this.sendReply(
          `Video received (${sizeStr})${caption}.`,
          msg,
        );
        break;
      }

      case "document": {
        const fname = mediaFilename ?? "unknown";
        const caption = msg.content ? `\nCaption: "${msg.content}"` : "";

        if (
          this.mediaAutoProcess &&
          this.mediaHandler &&
          mediaMimeType
        ) {
          const extracted = this.mediaHandler.extractDocumentText(
            mediaBuffer,
            mediaMimeType,
          );
          if (extracted.startsWith("(Binary")) {
            await this.handleChat(
              `[Document: ${fname} (${sizeStr})]${caption}\n\n${extracted}`,
              msg,
            );
          } else {
            await this.handleChat(
              `[Document: ${fname} (${sizeStr})]${caption}\n\nContent:\n${extracted}`,
              msg,
            );
          }
        } else {
          await this.sendReply(
            `Document received: ${fname} (${sizeStr})${caption}`,
            msg,
          );
        }
        break;
      }

      case "sticker": {
        await this.sendReply(`Sticker received (${sizeStr}).`, msg);
        break;
      }

      default:
        await this.sendReply(
          `${mediaType} received (${sizeStr}).`,
          msg,
        );
    }
  }

  // ══════════════════════════════════════════════════════════════
  // COMMANDS
  // ══════════════════════════════════════════════════════════════

  private async handleBangCommand(
    content: string,
    sourceMsg?: WhatsAppMessage,
  ): Promise<void> {
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
          `Session reset.\n\n_Active harness: ${this.harnessLabel(this.activeHarness)}_`,
        );
        return;

      case "model":
        if (argStr) {
          this.modelOverride = argStr;
          await this.bridge.sendMessage(`Model set to: ${argStr}`);
          return;
        }
        command = "model";
        break;

      case "opus":
        this.modelOverride = "claude-opus-4-6";
        await this.bridge.sendMessage("Model set to: claude-opus-4-6");
        return;

      case "sonnet":
        this.modelOverride = "claude-sonnet-4-6";
        await this.bridge.sendMessage("Model set to: claude-sonnet-4-6");
        return;

      case "haiku":
        this.modelOverride = "claude-haiku-4-5-20251001";
        await this.bridge.sendMessage("Model set to: claude-haiku-4-5-20251001");
        return;

      case "gemini":
        this.modelOverride = "google/gemini-2.5-flash-preview-05-20";
        await this.bridge.sendMessage(
          "Switched to Gemini 2.5 Flash (via OpenRouter).\n\n" +
            "_Note: This uses Gemini for general reasoning. For Google Workspace tasks (Docs, Drive, Gmail, Calendar), " +
            "use the Gemini bot on Discord — it has full authenticated Workspace access._",
        );
        return;

      case "sessions": {
        const active = this.sessionOrchestrator.getActiveSessions();
        if (active.length === 0) {
          await this.bridge.sendMessage("_No active orchestrated sessions._");
        } else {
          const lines = active.map((s) => {
            const elapsedMin = Math.round((Date.now() - s.startedAt) / 60_000);
            return `• *${s.harness}* [${s.state}] — ${elapsedMin}m — \`${s.id.slice(-8)}\``;
          });
          await this.bridge.sendMessage(`*Active sessions:*\n${lines.join("\n")}`);
        }
        return;
      }

      case "status":
      case "hq":
        if (this.activeJobId) {
          const label = this.activeJobLabel ?? "task";
          await this.bridge.sendMessage(
            `*Active task:* ${label}\n` +
              `Job ID: \`${this.activeJobId}\`\n` +
              `Status: running — waiting for result`,
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

      // ── New commands ─────────────────────────────────────────

      case "react": {
        if (!argStr) {
          await this.bridge.sendMessage("Usage: !react <emoji>\nExample: !react 🔥");
          return;
        }
        const targetMsg = this.lastReceivedMsg;
        if (!targetMsg?.rawMessage?.key) {
          await this.bridge.sendMessage("No recent message to react to.");
          return;
        }
        await this.bridge.sendReaction(targetMsg.rawMessage.key, argStr);
        return;
      }

      case "poll": {
        // Format: !poll Question | Option 1 | Option 2 | Option 3
        const pollParts = argStr.split("|").map((s) => s.trim());
        if (pollParts.length < 3) {
          await this.bridge.sendMessage(
            "Usage: !poll Question | Option 1 | Option 2 | ...\n" +
              "Example: !poll Favorite color | Red | Blue | Green",
          );
          return;
        }
        const pollName = pollParts[0];
        const pollOptions = pollParts.slice(1);
        await this.bridge.sendPoll(pollName, pollOptions);
        return;
      }

      case "location":
      case "loc": {
        // Format: !location <lat> <lng> [name]
        const locParts = argStr.split(/\s+/);
        if (locParts.length < 2) {
          await this.bridge.sendMessage(
            "Usage: !location <lat> <lng> [name]\n" +
              "Example: !location 0.3476 32.5825 Kampala",
          );
          return;
        }
        const lat = parseFloat(locParts[0]);
        const lng = parseFloat(locParts[1]);
        if (isNaN(lat) || isNaN(lng)) {
          await this.bridge.sendMessage("Invalid coordinates. Use decimal numbers.");
          return;
        }
        const locName = locParts.slice(2).join(" ") || undefined;
        await this.bridge.sendLocation(lat, lng, locName);
        return;
      }

      case "forward": {
        const lastMsg = this.lastReceivedMsg;
        if (!lastMsg?.rawMessage) {
          await this.bridge.sendMessage("No recent message to forward.");
          return;
        }
        await this.bridge.forwardMessage(lastMsg.rawMessage);
        return;
      }

      case "delete":
      case "del": {
        if (!this.lastSentMsgKey) {
          await this.bridge.sendMessage("No recent bot message to delete.");
          return;
        }
        await this.bridge.deleteMessage(this.lastSentMsgKey);
        this.lastSentMsgKey = null;
        return;
      }

      case "edit": {
        if (!argStr) {
          await this.bridge.sendMessage("Usage: !edit <new text>");
          return;
        }
        if (!this.lastSentMsgKey) {
          await this.bridge.sendMessage("No recent bot message to edit.");
          return;
        }
        await this.bridge.editMessage(this.lastSentMsgKey, argStr);
        return;
      }

      case "sticker": {
        const lastMsg = this.lastReceivedMsg;
        if (!lastMsg?.mediaBuffer || lastMsg.mediaType !== "image") {
          await this.bridge.sendMessage(
            "No recent image to convert. Send an image first, then type !sticker.",
          );
          return;
        }
        if (!this.mediaHandler) {
          await this.bridge.sendMessage("Media handler not available (sharp may not be installed).");
          return;
        }
        await this.bridge.sendTyping();
        const stickerBuf = await this.mediaHandler.prepareSticker(lastMsg.mediaBuffer);
        if (!stickerBuf) {
          await this.bridge.sendMessage(
            "Failed to convert image to sticker. Ensure sharp is installed.",
          );
          return;
        }
        await this.bridge.sendSticker(stickerBuf);
        return;
      }

      case "media": {
        if (argStr === "on") {
          this.mediaAutoProcess = true;
          await this.bridge.sendMessage(
            "Media auto-processing enabled. Images will be described by AI.",
          );
        } else if (argStr === "off") {
          this.mediaAutoProcess = false;
          await this.bridge.sendMessage(
            "Media auto-processing disabled. Media will be acknowledged but not analyzed.",
          );
        } else {
          const status = this.mediaAutoProcess ? "on" : "off";
          const vision = this.mediaHandler?.canDescribe ? "available" : "not configured";
          await this.bridge.sendMessage(
            `*Media settings*\n\nAuto-process: ${status}\nAI vision: ${vision}\n\n!media on — enable AI processing\n!media off — disable`,
          );
        }
        return;
      }

      case "format": {
        if (argStr === "on") {
          this.formatEnabled = true;
          await this.bridge.sendMessage("WhatsApp formatting enabled.");
        } else if (argStr === "off") {
          this.formatEnabled = false;
          await this.bridge.sendMessage("WhatsApp formatting disabled. Raw text mode.");
        } else {
          await this.bridge.sendMessage(
            `*Format settings*\n\nFormatting: ${this.formatEnabled ? "on" : "off"}\n\n!format on — convert markdown to WhatsApp\n!format off — send raw text`,
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
          auto: "auto",
        };
        if (!argStr) {
          await this.bridge.sendMessage(
            `*Active harness:* ${this.harnessLabel(this.activeHarness)}\n\n` +
              `!harness claude — pin to Claude Code\n` +
              `!harness opencode — pin to OpenCode\n` +
              `!harness gemini — pin to Gemini CLI\n` +
              `!harness auto — restore intent-based routing`,
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
            ? "Intent-based routing restored — workspace tasks → Gemini, coding tasks → Claude Code."
            : `All messages will now route to *${this.harnessLabel(target)}* until you change it with !harness auto.`;
        await this.bridge.sendMessage(
          `✓ Switched to *${this.harnessLabel(target)}*\n\n${desc}`,
        );
        return;
      }

      case "help":
      case "commands":
        await this.bridge.sendMessage(
          "*WhatsApp HQ Commands*\n\n" +
            "*Harness*\n" +
            "!harness — Show active harness\n" +
            "!harness claude — Pin to Claude Code\n" +
            "!harness opencode — Pin to OpenCode\n" +
            "!harness gemini — Pin to Gemini CLI\n" +
            "!harness auto — Auto-route by intent\n\n" +
            "*Chat*\n" +
            "!reset — Start new conversation\n" +
            "!model — Show active model\n" +
            "!model <name> — Set model by ID\n" +
            "!opus / !sonnet / !haiku — Quick Claude switch\n\n" +
            "*HQ*\n" +
            "!status — HQ agent / active task status\n" +
            "!memory — Show memory\n" +
            "!search <query> — Search vault\n" +
            "!threads — List conversation threads\n\n" +
            "*Media*\n" +
            "!sticker — Convert last image to sticker\n" +
            "!media [on|off] — Toggle AI media processing\n\n" +
            "*Interactive*\n" +
            "!react <emoji> — React to last message\n" +
            "!poll Q | Opt1 | Opt2 — Create a poll\n" +
            "!location <lat> <lng> [name] — Send location\n\n" +
            "*Message Ops*\n" +
            "!forward — Forward last received message\n" +
            "!delete — Delete last bot message\n" +
            "!edit <text> — Edit last bot message\n\n" +
            "*Settings*\n" +
            "!voice [on|off] — Toggle voice note replies\n" +
            "!format [on|off] — Toggle WhatsApp formatting\n" +
            "!help — This message",
        );
        return;

      default:
        await this.bridge.sendMessage(`Unknown command: !${cmd}. Try !help.`);
        return;
    }

    // Execute relay command (for commands that need relay)
    if (command) {
      await this.executeRelayCommand(command, args);
    }
  }

  private async handleVoiceCommand(argStr: string): Promise<void> {
    if (argStr === "on") {
      if (!this.voiceHandler || !this.voiceHandler.canSynthesize) {
        await this.bridge.sendMessage(
          "Voice reply not available — set OPENAI_API_KEY in .env.local to enable TTS.",
        );
      } else {
        this.voiceReplyEnabled = true;
        await this.bridge.sendMessage(
          "Voice reply enabled. I'll respond with voice notes.",
        );
      }
    } else if (argStr === "off") {
      this.voiceReplyEnabled = false;
      await this.bridge.sendMessage("Voice reply disabled. Back to text mode.");
    } else {
      const voiceStatus = this.voiceReplyEnabled ? "on" : "off";
      const voiceAvail = this.voiceHandler
        ? "available"
        : "not configured (set GROQ_API_KEY)";
      await this.bridge.sendMessage(
        `*Voice settings*\n\nTranscription: ${voiceAvail}\nReply mode: ${voiceStatus}\n\n!voice on — respond with voice notes\n!voice off — respond with text`,
      );
    }
  }

  private async executeRelayCommand(
    command: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    try {
      console.log(`[relay-whatsapp] Sending command to relay: ${command}`);
      const result = await new Promise<string>((resolve, reject) => {
        const requestId = `wa-cmd-${Date.now()}`;
        const unsub = this.relay.on<CmdResultMessage>(
          "cmd:result",
          (cmdMsg) => {
            if (cmdMsg.requestId === requestId) {
              unsub();
              if (cmdMsg.success) {
                resolve(cmdMsg.output ?? "Done.");
              } else {
                reject(new Error(cmdMsg.error ?? "Command failed"));
              }
            }
          },
        );

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
      console.error("[relay-whatsapp] Command error:", err);
      await this.bridge.sendMessage(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async processQueue(): Promise<void> {
    while (this.messageQueue.length > 0) {
      const queuedMsg = this.messageQueue.shift()!;
      const content = queuedMsg.content.trim();

      // Re-handle media messages from queue
      if (queuedMsg.mediaType && queuedMsg.mediaType !== "audio") {
        await this.handleMediaMessage(queuedMsg);
        continue;
      }

      if (!content) continue;

      console.log(
        `[relay-whatsapp] Processing queued message: "${content.substring(0, 40)}"`,
      );

      if (content.startsWith("!")) {
        await this.handleBangCommand(content, queuedMsg);
      } else if (this.activeHarness !== "auto") {
        await this.handleLocalHarness(content, this.activeHarness);
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
    harness: "claude-code" | "opencode" | "gemini-cli",
  ): Promise<void> {
    this.processing = true;
    const label = this.harnessLabel(harness);
    const sessionId = `wa-${Date.now()}`;

    let typingInterval: ReturnType<typeof setInterval> | null = null;
    try {
      await this.bridge.sendTyping();
      typingInterval = setInterval(async () => {
        try { await this.bridge.sendTyping(); } catch { /* non-critical */ }
      }, TYPING_KEEPALIVE_MS);

      console.log(`[relay-whatsapp] SessionOrchestrator: spawning ${label} session ${sessionId}`);

      await this.sessionOrchestrator.run(sessionId, harness, content, {
        onStatusUpdate: (_session, message) => {
          console.log(`[relay-whatsapp] Session ${sessionId}: ${message}`);
          this.bridge.sendMessage(message).catch(console.error);
        },
        onResult: (_session, result) => {
          if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
          this.bridge.stopTyping().catch(() => {});
          const formatted = this.formatEnabled ? formatForWhatsApp(result) : result;
          this.sendChunked(formatted).catch(console.error);
        },
        onFailed: (_session, error) => {
          if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
          this.bridge.stopTyping().catch(() => {});
          console.error(`[relay-whatsapp] Session ${sessionId} failed: ${error}`);
          this.bridge.sendMessage(`_${label} failed: ${error}_`).catch(console.error);
        },
      });
    } catch (err) {
      if (typingInterval) clearInterval(typingInterval);
      console.error(`[relay-whatsapp] Orchestrator error for session ${sessionId}:`, err);
      await this.bridge.sendMessage(
        `_${label} error: ${err instanceof Error ? err.message : String(err)}_`,
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
      const valid: ActiveHarness[] = ["auto", "claude-code", "opencode", "gemini-cli"];
      if (data.activeHarness && valid.includes(data.activeHarness as ActiveHarness)) {
        this.activeHarness = data.activeHarness as ActiveHarness;
        console.log(`[relay-whatsapp] Loaded persisted harness: ${this.activeHarness}`);
      }
    } catch {
      // File doesn't exist yet — default "auto" is already set
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
      console.error("[relay-whatsapp] Failed to save state:", err);
    }
  }

  private harnessLabel(h: ActiveHarness): string {
    switch (h) {
      case "claude-code": return "Claude Code";
      case "opencode": return "OpenCode";
      case "gemini-cli": return "Gemini CLI";
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
    const harnessLabel =
      harness === "gemini-cli"
        ? "Gemini CLI"
        : harness === "claude-code"
          ? "Claude Code"
          : harness === "opencode"
            ? "OpenCode"
            : "HQ";

    try {
      await this.bridge.sendMessage(`_Routing to ${harnessLabel}..._`);

      const roleHint = role ? ` role=${role}` : "";
      const instruction =
        `[WHATSAPP_ORCHESTRATION targetHarness=${harness}${roleHint}]\n\n` +
        `<user_message>\n${content}\n</user_message>\n\n` +
        `Use the delegate_to_relay tool to handle the user's request above via ${harness}${role ? ` with role="${role}"` : ""}. ` +
        `Return the complete response to the user.`;

      const jobId = await new Promise<string>((resolve, reject) => {
        const requestId = `wa-job-${Date.now()}`;
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
          reject(new Error("Job submit timeout — agent may be offline"));
        }, 15_000);
      });

      console.log(`[relay-whatsapp] Job submitted: ${jobId} → ${harness}`);
      this.activeJobId = jobId;
      this.activeJobLabel = harnessLabel;
      this.activeJobResultDelivered = false;

      await this.bridge.sendMessage(
        `_Task queued (job: \`${jobId.slice(-8)}\`). ${harnessLabel} will respond shortly. Type !status for updates._`,
      );

      // 10-min failsafe
      setTimeout(async () => {
        if (this.activeJobId === jobId && !this.activeJobResultDelivered) {
          console.warn(
            `[relay-whatsapp] Job ${jobId} timed out — falling back to direct chat`,
          );
          this.activeJobId = null;
          this.activeJobLabel = null;
          this.activeTaskIds.clear();
          this.processing = false;
          await this.bridge.sendMessage(
            `_${harnessLabel} didn't respond in time. Answering directly..._`,
          );
          await this.handleChat(content);
        }
      }, 10 * 60 * 1000);
    } catch (err) {
      console.error("[relay-whatsapp] Delegation setup error:", err);
      this.activeJobId = null;
      this.activeJobLabel = null;
      this.activeTaskIds.clear();
      this.processing = false;
      await this.bridge.sendMessage(
        `_${harnessLabel} unavailable — answering directly..._`,
      );
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
          console.log(
            `[relay-whatsapp] Task created: ${taskId} for job ${this.activeJobId}`,
          );
        }
        break;

      case "task:claimed":
        if (this.activeJobId && taskId && this.activeTaskIds.has(taskId)) {
          const claimedBy =
            data?.claimedBy ?? (harnessFromPath(filePath) ?? "a bot");
          await this.bridge.sendMessage(
            `_${claimedBy} is now working on your request..._`,
          );
        }
        break;

      case "task:completed":
        if (
          this.activeJobId &&
          taskId &&
          this.activeTaskIds.has(taskId) &&
          !this.activeJobResultDelivered
        ) {
          console.log(
            `[relay-whatsapp] Task completed: ${taskId} — fetching result`,
          );
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
          console.log(
            `[relay-whatsapp] Job completed: ${fileJobId} — fetching result`,
          );
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
          await this.bridge.sendMessage(
            "_The delegated task failed. Try again or rephrase._",
          );
        }
        break;
    }
  }

  private fetchTaskResult(taskId: string): Promise<string | null> {
    return new Promise((resolve) => {
      const requestId = `wa-tres-${Date.now()}`;
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
      setTimeout(() => {
        unsub();
        resolve(null);
      }, 8_000);
    });
  }

  private fetchJobResult(jobId: string): Promise<string | null> {
    return new Promise((resolve) => {
      const requestId = `wa-jres-${Date.now()}`;
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
      setTimeout(() => {
        unsub();
        resolve(null);
      }, 8_000);
    });
  }

  // ══════════════════════════════════════════════════════════════
  // CHAT
  // ══════════════════════════════════════════════════════════════

  private async handleChat(
    content: string,
    sourceMsg?: WhatsAppMessage,
  ): Promise<void> {
    this.processing = true;
    const requestId = `wa-chat-${Date.now()}`;

    // Start typing indicator with keepalive
    let typingInterval: ReturnType<typeof setInterval> | null = null;
    try {
      await this.bridge.sendTyping();
      typingInterval = setInterval(async () => {
        try {
          await this.bridge.sendTyping();
        } catch {
          // Non-critical
        }
      }, TYPING_KEEPALIVE_MS);
    } catch {
      // Non-critical
    }

    try {
      console.log(
        `[relay-whatsapp] Sending chat to relay: requestId=${requestId}, threadId=${this.threadId ?? "new"}`,
      );

      let buffer = "";
      let deltaCount = 0;

      const finalMsg = await new Promise<ChatFinalMessage>(
        (resolve, reject) => {
          const unsub1 = this.relay.on<ChatDeltaMessage>(
            "chat:delta",
            (deltaMsg) => {
              if (deltaMsg.requestId === requestId) {
                deltaCount++;
                buffer += deltaMsg.delta;
                if (deltaCount % 20 === 0) {
                  console.log(
                    `[relay-whatsapp] Streaming: ${deltaCount} deltas, ${buffer.length} chars so far`,
                  );
                }
              }
            },
          );

          const unsub2 = this.relay.on<ChatFinalMessage>(
            "chat:final",
            (msg) => {
              if (msg.requestId === requestId) {
                unsub1();
                unsub2();
                unsub3();
                resolve(msg);
              }
            },
          );

          const unsub3 = this.relay.on("error", (errMsg) => {
            if ((errMsg as any).requestId === requestId) {
              unsub1();
              unsub2();
              unsub3();
              reject(
                new Error((errMsg as any).message ?? "Unknown relay error"),
              );
            }
          });

          try {
            this.relay.send({
              type: "chat:send",
              content,
              threadId: this.threadId ?? undefined,
              requestId,
              modelOverride: this.modelOverride,
            });
          } catch (sendErr) {
            unsub1();
            unsub2();
            unsub3();
            reject(sendErr);
            return;
          }

          // Timeout after 10 minutes
          setTimeout(() => {
            unsub1();
            unsub2();
            unsub3();
            reject(new Error("Request timed out (10 min)"));
          }, 10 * 60 * 1000);
        },
      );

      // Save thread ID
      if (finalMsg.threadId && !this.threadId) {
        this.threadId = finalMsg.threadId;
        console.log(`[relay-whatsapp] Thread ID saved: ${this.threadId}`);
      }

      // Stop typing before sending
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
      }
      await this.bridge.stopTyping();

      // Send the response
      const responseText = finalMsg.content || buffer;
      console.log(
        `[relay-whatsapp] Response ready: ${responseText.length} chars`,
      );

      if (responseText.trim()) {
        if (this.voiceReplyEnabled && this.voiceHandler) {
          try {
            console.log("[relay-whatsapp] Synthesizing voice reply...");
            await this.bridge.sendRecording();
            const audioBuffer =
              await this.voiceHandler.synthesize(responseText);
            await this.bridge.sendVoiceNote(audioBuffer);
          } catch (err) {
            console.error(
              "[relay-whatsapp] TTS failed, falling back to text:",
              err,
            );
            await this.sendFormattedResponse(responseText, sourceMsg);
          }
        } else {
          await this.sendFormattedResponse(responseText, sourceMsg);
        }

        // Auto-react with ✅ to indicate completion
        if (sourceMsg?.rawMessage?.key) {
          await this.bridge.sendReaction(sourceMsg.rawMessage.key, "✅");
        }
      } else {
        console.warn(`[relay-whatsapp] Empty response from relay`);
        await this.bridge.sendMessage(
          "(No response from agent — the relay server may not have an active agent or LLM backend configured.)",
        );
      }
    } catch (err) {
      console.error("[relay-whatsapp] Chat error:", err);
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
      }
      try {
        await this.bridge.stopTyping();
      } catch {
        // ignore
      }
      await this.bridge.sendMessage(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (typingInterval) {
        clearInterval(typingInterval);
      }
      this.processing = false;
    }
  }

  // ══════════════════════════════════════════════════════════════
  // SEND HELPERS
  // ══════════════════════════════════════════════════════════════

  /** Send a response with optional formatting and quoting. */
  private async sendFormattedResponse(
    text: string,
    sourceMsg?: WhatsAppMessage,
  ): Promise<void> {
    const formatted = this.formatEnabled ? formatForWhatsApp(text) : text;
    await this.sendChunked(formatted, sourceMsg);
  }

  /** Send a reply quoting the original message. */
  private async sendReply(
    text: string,
    sourceMsg?: WhatsAppMessage,
  ): Promise<void> {
    const formatted = this.formatEnabled ? formatForWhatsApp(text) : text;

    if (sourceMsg?.rawMessage) {
      const msgId = await this.bridge.sendMessage(formatted, {
        quoted: sourceMsg.rawMessage,
      });
      if (msgId) {
        this.lastSentMsgKey = {
          remoteJid: this.guard.ownerJid,
          id: msgId,
          fromMe: true,
        };
      }
    } else {
      const msgId = await this.bridge.sendMessage(formatted);
      if (msgId) {
        this.lastSentMsgKey = {
          remoteJid: this.guard.ownerJid,
          id: msgId,
          fromMe: true,
        };
      }
    }
  }

  /** Split long messages into chunks and send sequentially. Quotes original on first chunk. */
  /**
   * Extract [FILE: /path | name] markers from text, send each as a WhatsApp image,
   * and return the cleaned text (markers stripped).
   */
  private async extractAndSendFiles(text: string): Promise<string> {
    const FILE_RE = /\[FILE:\s*([^\]|]+?)(?:\s*\|\s*([^\]]+?))?\s*\]/g;
    const filePaths: Array<{ path: string; name: string }> = [];
    const cleanText = text.replace(FILE_RE, (_match, rawPath, rawName) => {
      filePaths.push({ path: rawPath.trim(), name: rawName?.trim() ?? basename(rawPath.trim()) });
      return "";
    }).replace(/\n{3,}/g, "\n\n").trim();

    for (const f of filePaths) {
      try {
        if (!existsSync(f.path)) {
          console.warn(`[whatsapp] File not found, skipping: ${f.path}`);
          continue;
        }
        const buffer = readFileSync(f.path);
        await this.bridge.sendImage(buffer, f.name);
        console.log(`[whatsapp] Sent image: ${f.name}`);
      } catch (err: any) {
        console.error(`[whatsapp] Failed to send image ${f.path}:`, err.message);
      }
    }

    return cleanText;
  }

  private async sendChunked(
    text: string,
    sourceMsg?: WhatsAppMessage,
  ): Promise<void> {
    // Extract and send any [FILE:] attachments before sending text
    text = await this.extractAndSendFiles(text);
    if (text.length <= MAX_CHUNK_SIZE) {
      // Single message — quote original if available
      if (sourceMsg?.rawMessage) {
        const msgId = await this.bridge.sendMessage(text, {
          quoted: sourceMsg.rawMessage,
        });
        if (msgId) {
          this.lastSentMsgKey = {
            remoteJid: this.guard.ownerJid,
            id: msgId,
            fromMe: true,
          };
        }
      } else {
        const msgId = await this.bridge.sendMessage(text);
        if (msgId) {
          this.lastSentMsgKey = {
            remoteJid: this.guard.ownerJid,
            id: msgId,
            fromMe: true,
          };
        }
      }
      return;
    }

    // Split at paragraph boundaries when possible
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

    console.log(
      `[relay-whatsapp] Sending ${chunks.length} chunks (total: ${text.length} chars)`,
    );

    for (let i = 0; i < chunks.length; i++) {
      // Quote original on first chunk only
      if (i === 0 && sourceMsg?.rawMessage) {
        const msgId = await this.bridge.sendMessage(chunks[i], {
          quoted: sourceMsg.rawMessage,
        });
        if (msgId) {
          this.lastSentMsgKey = {
            remoteJid: this.guard.ownerJid,
            id: msgId,
            fromMe: true,
          };
        }
      } else {
        const msgId = await this.bridge.sendMessage(chunks[i]);
        if (msgId) {
          this.lastSentMsgKey = {
            remoteJid: this.guard.ownerJid,
            id: msgId,
            fromMe: true,
          };
        }
      }
    }
  }
}

/**
 * RelayDiscordBot — Thin Discord bot using the relay server via RelayClient.
 *
 * Coexists with the existing discord-relay. Routes all messages through
 * the relay server instead of directly calling vault/harnesses.
 *
 * Features:
 * - Real-time streaming (edits Discord message as tokens arrive)
 * - ! commands routed as cmd:execute messages
 * - Job submission via /hq prefix
 * - Session per Discord channel
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  PresenceUpdateStatus,
  ActivityType,
  type Message,
} from "discord.js";
import { RelayClient } from "@repo/agent-relay-protocol";
import type {
  RelayClientConfig,
  CmdResultMessage,
  ChatDeltaMessage,
  ChatFinalMessage,
} from "@repo/agent-relay-protocol";
import { chunkMessage } from "./chunker.js";

const STREAMING_EDIT_INTERVAL_MS = 800; // How often to edit the Discord message during streaming

export interface RelayDiscordBotConfig {
  discordBotToken: string;
  discordUserId: string;
  relayHost?: string;
  relayPort?: number;
  apiKey?: string;
  debug?: boolean;
}

export class RelayDiscordBot {
  private client: Client | null = null;
  private relay: RelayClient;
  private config: RelayDiscordBotConfig;
  /** Per-channel thread IDs */
  private channelThreads = new Map<string, string>();
  /** Per-channel model overrides */
  private channelModels = new Map<string, string>();
  private processedMessages = new Set<string>();

  constructor(config: RelayDiscordBotConfig) {
    this.config = config;

    const relayConfig: RelayClientConfig = {
      host: config.relayHost,
      port: config.relayPort,
      apiKey: config.apiKey ?? "",
      clientId: "discord-relay-adapter",
      clientType: "discord",
      autoReconnect: true,
      debug: config.debug,
    };

    this.relay = new RelayClient(relayConfig);
  }

  async start(): Promise<void> {
    // Connect to relay server
    await this.relay.connect();
    console.log("[relay-discord] Connected to relay server");

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.client.once("ready", () => {
      console.log(`[relay-discord] Connected as: ${this.client!.user?.tag}`);
      this.client!.user?.setPresence({
        status: PresenceUpdateStatus.Online,
        activities: [{ name: "via relay server", type: ActivityType.Listening }],
      });
    });

    this.client.on("messageCreate", (msg) => this.handleMessage(msg));
    this.client.on("error", (err) =>
      console.error("[relay-discord] Discord error:", err.message),
    );

    await this.client.login(this.config.discordBotToken);
  }

  async stop(): Promise<void> {
    this.relay.disconnect();
    if (this.client) {
      await this.client.destroy();
      this.client = null;
    }
    console.log("[relay-discord] Bot stopped");
  }

  private async handleMessage(msg: Message): Promise<void> {
    // Dedup & filter
    if (this.processedMessages.has(msg.id)) return;
    if (msg.author.id !== this.config.discordUserId) return;
    if (msg.author.bot) return;

    this.processedMessages.add(msg.id);
    if (this.processedMessages.size > 200) {
      const first = this.processedMessages.values().next().value;
      if (first) this.processedMessages.delete(first);
    }

    const content = msg.content.trim();
    if (!content) return;

    const channelId = msg.channelId;

    // ── ! Commands ─────────────────────────────────────────────────
    if (content.startsWith("!")) {
      await this.handleBangCommand(msg, content, channelId);
      return;
    }

    // ── /hq <instruction> — submit as background job ───────────────
    if (content.startsWith("/hq ")) {
      await this.handleJobSubmit(msg, content.slice(4).trim());
      return;
    }

    // ── Regular chat message ────────────────────────────────────────
    await this.handleChat(msg, content, channelId);
  }

  private async handleBangCommand(
    msg: Message,
    content: string,
    channelId: string,
  ): Promise<void> {
    const parts = content.slice(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const argStr = parts.slice(1).join(" ").trim();

    // Map Discord commands to relay cmd:execute
    let command: string;
    let args: Record<string, unknown> = {};

    switch (cmd) {
      case "reset":
      case "new":
        command = "reset";
        this.channelThreads.delete(channelId);
        this.channelModels.delete(channelId);
        break;
      case "session":
        command = "session";
        break;
      case "model":
        command = "model";
        if (argStr) {
          args.model = argStr;
          this.channelModels.set(channelId, argStr);
        }
        break;
      case "opus":
        command = "model";
        args.model = "claude-opus-4-6";
        this.channelModels.set(channelId, "claude-opus-4-6");
        break;
      case "sonnet":
        command = "model";
        args.model = "claude-sonnet-4-6";
        this.channelModels.set(channelId, "claude-sonnet-4-6");
        break;
      case "haiku":
        command = "model";
        args.model = "claude-haiku-4-5-20251001";
        this.channelModels.set(channelId, "claude-haiku-4-5-20251001");
        break;
      case "status":
      case "hq":
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
      case "clear":
      case "defaults":
        command = "clear";
        this.channelThreads.delete(channelId);
        this.channelModels.delete(channelId);
        break;
      case "help":
      case "commands":
        command = "help";
        break;
      default:
        await msg.reply(`Unknown command: \`!${cmd}\`. Try \`!help\`.`);
        return;
    }

    try {
      const result = await new Promise<string>((resolve, reject) => {
        const requestId = `cmd-${Date.now()}`;
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

      // Send result as chunks
      const chunks = chunkMessage(result);
      for (const chunk of chunks) {
        await msg.reply(chunk);
      }
    } catch (err) {
      await msg.reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleJobSubmit(msg: Message, instruction: string): Promise<void> {
    if (!instruction) {
      await msg.reply("Usage: `/hq <instruction>`");
      return;
    }

    try {
      const placeholder = await msg.reply("Submitting job to HQ...");
      const submitted = await this.relay.submitJob({
        instruction,
        jobType: "background",
      });

      await placeholder.edit(
        `Job submitted: \`${submitted.jobId}\`\nStatus: pending. I'll update when done.`,
      );

      // Wait for completion and update message
      const completed = await this.relay.waitForJob(submitted.jobId);
      const status = completed.status === "done" ? "Done" : "Failed";
      const resultText = completed.result ?? completed.error ?? "No output.";
      const chunks = chunkMessage(`**${status}** (job \`${submitted.jobId}\`)\n${resultText}`);
      await placeholder.edit(chunks[0]);
      for (const chunk of chunks.slice(1)) {
        await msg.reply(chunk);
      }
    } catch (err) {
      await msg.reply(`Job error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleChat(
    msg: Message,
    content: string,
    channelId: string,
  ): Promise<void> {
    const requestId = `chat-${Date.now()}`;
    const threadId = this.channelThreads.get(channelId);
    const modelOverride = this.channelModels.get(channelId);

    // Send typing indicator
    if ("sendTyping" in msg.channel) {
      (msg.channel as any).sendTyping();
    }

    let placeholder: Message | null = null;
    let accumulated = "";
    let lastEdit = 0;
    let editTimer: ReturnType<typeof setInterval> | null = null;

    const startStreaming = async () => {
      placeholder = await msg.reply("...");
      // Edit message periodically as tokens stream in
      editTimer = setInterval(async () => {
        if (placeholder && accumulated && Date.now() - lastEdit > STREAMING_EDIT_INTERVAL_MS) {
          try {
            const preview = accumulated.length > 1900
              ? accumulated.substring(0, 1900) + "..."
              : accumulated;
            await placeholder.edit(preview);
            lastEdit = Date.now();
          } catch {
            // Ignore edit failures
          }
        }
      }, STREAMING_EDIT_INTERVAL_MS);
    };

    try {
      let streamStarted = false;

      // Set up delta listener before sending
      const unsubDelta = this.relay.on<ChatDeltaMessage>("chat:delta", (deltaMsg) => {
        if (deltaMsg.requestId === requestId) {
          accumulated += deltaMsg.delta;
          if (!streamStarted) {
            streamStarted = true;
            startStreaming();
          }
        }
      });

      const unsubFinal = this.relay.on<ChatFinalMessage>("chat:final", async (finalMsg) => {
        if (finalMsg.requestId === requestId) {
          unsubDelta();
          unsubFinal();
          if (editTimer) clearInterval(editTimer);

          // Save thread ID if provided
          if (finalMsg.threadId && !threadId) {
            this.channelThreads.set(channelId, finalMsg.threadId);
          }

          const response = finalMsg.content;
          const chunks = chunkMessage(response);

          if (placeholder) {
            await placeholder.edit(chunks[0]);
            for (const chunk of chunks.slice(1)) {
              await msg.reply(chunk);
            }
          } else {
            for (const chunk of chunks) {
              await msg.reply(chunk);
            }
          }
        }
      });

      const unsubError = this.relay.on("error", async (errMsg) => {
        if ((errMsg as any).requestId === requestId) {
          unsubDelta();
          unsubFinal();
          unsubError();
          if (editTimer) clearInterval(editTimer);
          const errText = (errMsg as any).message ?? "Unknown error";
          if (placeholder) {
            await placeholder.edit(`Error: ${errText}`);
          } else {
            await msg.reply(`Error: ${errText}`);
          }
        }
      });

      // Send chat message
      this.relay.send({
        type: "chat:send",
        content,
        threadId,
        requestId,
        modelOverride,
      });

      // Timeout after 5 minutes
      setTimeout(async () => {
        unsubDelta();
        unsubFinal();
        unsubError();
        if (editTimer) clearInterval(editTimer);
        if (placeholder && !accumulated) {
          await placeholder.edit("Request timed out.").catch(() => {});
        }
      }, 5 * 60 * 1000);
    } catch (err) {
      if (editTimer) clearInterval(editTimer);
      await msg.reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

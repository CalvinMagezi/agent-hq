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

    let buffer = "";
    let charsSent = 0;

    // Keep typing indicator alive while waiting
    if ("sendTyping" in msg.channel) (msg.channel as any).sendTyping();
    const typingInterval = setInterval(() => {
      if ("sendTyping" in msg.channel) (msg.channel as any).sendTyping();
    }, 8000);

    // Send buffer to Discord when a natural break is ready
    const flushBuffer = async (force = false) => {
      const hasParagraph = buffer.includes("\n\n") && buffer.length > 300;
      const overLimit = buffer.length > 1600;

      if (hasParagraph) {
        const splitAt = buffer.lastIndexOf("\n\n");
        const toSend = buffer.substring(0, splitAt);
        buffer = buffer.substring(splitAt + 2);
        for (const chunk of chunkMessage(toSend)) {
          await msg.reply(chunk);
          charsSent += chunk.length;
        }
      } else if (overLimit) {
        for (const chunk of chunkMessage(buffer)) {
          await msg.reply(chunk);
          charsSent += chunk.length;
        }
        buffer = "";
      } else if (force && buffer.trim()) {
        for (const chunk of chunkMessage(buffer)) {
          await msg.reply(chunk);
          charsSent += chunk.length;
        }
        buffer = "";
      }
    };

    try {
      const unsubDelta = this.relay.on<ChatDeltaMessage>("chat:delta", async (deltaMsg) => {
        if (deltaMsg.requestId !== requestId) return;
        buffer += deltaMsg.delta;
        await flushBuffer();
      });

      const unsubFinal = this.relay.on<ChatFinalMessage>("chat:final", async (finalMsg) => {
        if (finalMsg.requestId !== requestId) return;
        unsubDelta();
        unsubFinal();
        clearInterval(typingInterval);

        if (finalMsg.threadId && !threadId) {
          this.channelThreads.set(channelId, finalMsg.threadId);
        }

        if (charsSent === 0) {
          // Short response — nothing streamed yet, send full content
          for (const chunk of chunkMessage(finalMsg.content)) {
            await msg.reply(chunk);
          }
        } else {
          // Flush any remaining buffered content
          await flushBuffer(true);
        }
      });

      const unsubError = this.relay.on("error", async (errMsg) => {
        if ((errMsg as any).requestId !== requestId) return;
        unsubDelta();
        unsubFinal();
        unsubError();
        clearInterval(typingInterval);
        await msg.reply(`Error: ${(errMsg as any).message ?? "Unknown error"}`);
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
        clearInterval(typingInterval);
        if (charsSent === 0) {
          await msg.reply("Request timed out.").catch(() => {});
        }
      }, 5 * 60 * 1000);
    } catch (err) {
      clearInterval(typingInterval);
      await msg.reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

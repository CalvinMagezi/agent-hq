import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PresenceUpdateStatus,
  ActivityType,
  MessageFlags,
  type Message,
} from "discord.js";
import { writeFile, unlink, mkdir } from "fs/promises";
import * as fs from "fs";
import * as path from "path";
import { join } from "path";
import type { BaseHarness } from "./harnesses/base.js";
import { ContextEnricher } from "./context.js";
import { VaultAPI as ConvexAPI } from "./vaultApi.js";
import { processMemoryIntents } from "./memory.js";
import { chunkMessage } from "./chunker.js";
import { classifyIntent } from "./intent.js";
import { handleCommand } from "./commands.js";
import { createTranscriber, type Transcriber } from "./transcribe.js";
import type { RelayConfig } from "./types.js";

const MAX_INLINE_RESULT = 8000;

const MAX_DEDUP_SIZE = 200;

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
 * A self-contained Discord bot instance wrapping a specific CLI harness.
 * Multiple BotInstances can run in the same process with different tokens and harnesses.
 */
export class BotInstance {
  private client: Client | null = null;
  private harness: BaseHarness;
  private enricher: ContextEnricher;
  private convex: ConvexAPI;
  private config: RelayConfig;
  private transcriber: Transcriber | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private delegationInterval: ReturnType<typeof setInterval> | null = null;
  private isDelegating = false; // Prevent concurrent delegation processing
  private processedMessages = new Set<string>();
  private agentId: string;
  private harnessType: string;
  private syncCleanup: (() => void) | null = null;
  /** Shared VaultSync instance injected from index.ts — avoids multiple SQLite writers */
  private sharedSync: any | null = null;

  constructor(config: RelayConfig, harness: BaseHarness, sharedSync?: any) {
    this.config = config;
    this.harness = harness;
    this.agentId = `discord-relay-${harness.harnessName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    this.harnessType = harness.harnessName.toLowerCase().replace(/\s+/g, "-");
    this.convex = new ConvexAPI(config);
    this.enricher = new ContextEnricher(this.convex, config, this.harnessType);
    this.sharedSync = sharedSync ?? null;
  }

  async start(): Promise<void> {
    await this.harness.init();
    await this.enricher.loadProfile();
    this.transcriber = createTranscriber(this.config);

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
      console.log(`[${this.harness.harnessName}] Discord bot connected as: ${this.client!.user?.tag}`);

      if (!this.config.discordBotId && this.client!.user) {
        this.config.discordBotId = this.client!.user.id;
      }

      this.client!.user?.setPresence({
        status: PresenceUpdateStatus.Online,
        activities: [{ name: "Ready for messages", type: ActivityType.Listening }],
      });
    });

    this.client.on("messageCreate", (msg) => this.handleMessage(msg));
    this.client.on("error", (err) => console.error(`[${this.harness.harnessName}] Discord error:`, err.message));

    await this.client.login(this.config.discordBotToken);

    const capabilities = this.getCapabilities();
    const heartbeatMeta = {
      type: "discord-relay",
      name: `Discord Relay (${this.harness.harnessName})`,
      harnessType: this.harnessType,
      capabilities,
    };
    await this.convex.sendHeartbeat(this.agentId, "online", heartbeatMeta);
    // Register relay health with capabilities
    await this.convex.updateRelayHealth(
      this.agentId,
      this.harnessType,
      `Discord Relay (${this.harness.harnessName})`,
      capabilities,
    );
    this.heartbeatInterval = setInterval(async () => {
      await this.convex.sendHeartbeat(this.agentId, "online", heartbeatMeta);
    }, 20000);

    // Event-driven delegation with polling fallback
    await this.initSyncDelegation();
    console.log(`[${this.harness.harnessName}] Delegation monitoring started`);
  }

  async stop(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.delegationInterval) {
      clearInterval(this.delegationInterval);
      this.delegationInterval = null;
    }
    if (this.syncCleanup) {
      this.syncCleanup();
      this.syncCleanup = null;
    }
    await this.convex.sendHeartbeat(this.agentId, "offline").catch(() => {});
    if (this.client) {
      await this.client.destroy();
      this.client = null;
      console.log(`[${this.harness.harnessName}] Discord bot stopped.`);
    }
  }

  /** Initialize event-driven delegation monitoring with sync engine fallback to polling. */
  private async initSyncDelegation(): Promise<void> {
    // Use injected shared sync instance to avoid multiple VaultSync instances
    // opening the same SQLite DB (causes SQLITE_BUSY and duplicate fs.watch watchers)
    const sync = this.sharedSync;
    if (sync?.on) {
      try {
        const unsub = sync.on("task:created", () => {
          this.checkPendingDelegations();
        });
        // syncCleanup only unsubscribes the listener — does NOT stop the shared sync
        this.syncCleanup = () => unsub();
        this.delegationInterval = setInterval(() => this.checkPendingDelegations(), 30_000);
        console.log(`[${this.harness.harnessName}] Using shared sync engine — event-driven delegation with 30s fallback`);
        return;
      } catch (err) {
        console.warn(`[${this.harness.harnessName}] Could not subscribe to shared sync:`, err);
      }
    }

    // No shared sync — create a dedicated one for this bot
    try {
      const { VaultSync } = await import("@repo/vault-sync");
      const vaultPath = this.config.vaultPath;
      if (!vaultPath) throw new Error("No vault path configured");

      const ownSync = new VaultSync({
        vaultPath,
        debounceMs: 200,
        stabilityMs: 500,
        fullScanIntervalMs: 3_600_000,
      });
      await ownSync.start();

      const unsub = ownSync.on("task:created", () => {
        this.checkPendingDelegations();
      });

      this.syncCleanup = () => {
        unsub();
        ownSync.stop();
      };

      this.delegationInterval = setInterval(() => this.checkPendingDelegations(), 30_000);
      console.log(`[${this.harness.harnessName}] Sync engine active — event-driven delegation with 30s fallback`);
    } catch (err) {
      // Fallback to legacy 5s polling if sync engine is unavailable
      console.warn(`[${this.harness.harnessName}] Sync engine not available, using 5s polling:`, err);
      this.delegationInterval = setInterval(() => this.checkPendingDelegations(), 5000);
    }
  }

  /** Return capabilities based on harness type */
  private getCapabilities(): string[] {
    switch (this.harnessType) {
      case "claude-code":
        return ["code", "git", "file-ops", "refactor", "debug", "test"];
      case "opencode":
        return ["code", "multi-model", "file-ops", "generation"];
      case "gemini-cli":
        return ["google-workspace", "google-docs", "google-sheets", "google-drive", "gmail", "google-calendar", "research", "analysis", "large-context", "summarization"];
      default:
        return ["general"];
    }
  }

  /** Poll for delegated tasks from HQ and execute them */
  private async checkPendingDelegations(): Promise<void> {
    if (this.isDelegating) return; // Skip if already processing

    try {
      const tasks = await this.convex.getPendingDelegations(
        this.agentId,
        this.harnessType,
      );

      if (tasks.length === 0) return;

      this.isDelegating = true;

      for (const task of tasks) {
        console.log(
          `[${this.harness.harnessName}] Delegation: claiming task ${task.taskId} (${task.instruction.substring(0, 60)}...)`,
        );

        // Claim the task
        const claimed = await this.convex.claimDelegation(
          task._id,
          this.agentId,
        );
        if (!claimed) {
          console.log(`[${this.harness.harnessName}] Delegation: task ${task.taskId} already claimed by another relay`);
          continue;
        }

        // Mark as running
        await this.convex.updateDelegation(task._id, "running");
        this.setBotPresence("busy");

        // ── Trace recording (best-effort) ───────────────────────────
        let traceDb: any = null;
        let relaySpanId: string | null = null;
        if (task.traceId && this.config.vaultPath) {
          try {
            const { TraceDB } = await import("@repo/vault-client/trace");
            traceDb = new TraceDB(this.config.vaultPath);
            relaySpanId = traceDb.createSpan({
              traceId: task.traceId,
              parentSpanId: task.spanId,
              taskId: task.taskId,
              type: "relay_exec",
              name: `${this.harnessType}:${task.taskId}`,
            });
            traceDb.addSpanEvent(relaySpanId, task.traceId, "claimed", `Claimed by ${this.agentId}`);
          } catch {
            // Non-fatal — tracing is best-effort
            traceDb = null;
            relaySpanId = null;
          }
        }

        // ── Cancellation signal path ─────────────────────────────────
        const signalsDir = this.config.vaultPath
          ? path.join(this.config.vaultPath, "_delegation/signals")
          : null;
        const signalPath = signalsDir
          ? path.join(signalsDir, `cancel-${task.taskId}.md`)
          : null;

        // Clean up any stale signal from a previous run
        if (signalPath && fs.existsSync(signalPath)) {
          try { fs.unlinkSync(signalPath); } catch { /* ignore */ }
        }

        let cancelCheckInterval: ReturnType<typeof setInterval> | null = null;
        let wasCancelled = false;

        try {
          // ── Build instruction with security constraints ───────────────
          let instruction = task.instruction;
          const sc = task.securityConstraints;
          if (sc) {
            const lines: string[] = [
              "SECURITY CONSTRAINTS (enforced — violation will fail the task):",
            ];
            if (sc.noGit) lines.push("- Do NOT run any git commands");
            if (sc.noNetwork) lines.push("- Do NOT make any network requests");
            if (sc.filesystemAccess === "read-only") lines.push("- Read-only filesystem access — do NOT write or delete files");
            if (sc.allowedDirectories?.length) lines.push(`- Only access these directories: ${sc.allowedDirectories.join(", ")}`);
            if (sc.blockedCommands?.length) lines.push(`- Do NOT run commands matching: ${sc.blockedCommands.join(", ")}`);
            if (lines.length > 1) {
              instruction = `${lines.join("\n")}\n\n${instruction}`;
            }
          }

          const channelId = task.discordChannelId || `delegation-${task.taskId}`;
          const options: any = {};
          if (task.modelOverride) {
            options.channelSettings = { model: task.modelOverride };
          }

          // ── Start cancellation polling ────────────────────────────────
          if (signalPath) {
            cancelCheckInterval = setInterval(() => {
              if (fs.existsSync(signalPath)) {
                wasCancelled = true;
                this.harness.kill?.(channelId);
                if (cancelCheckInterval) {
                  clearInterval(cancelCheckInterval);
                  cancelCheckInterval = null;
                }
              }
            }, 2000);
          }

          // ── Live output streaming callback ────────────────────────────
          const liveChunkCallback = (chunk: string) => {
            this.convex.writeLiveChunk(task.taskId, this.agentId, chunk);
          };

          // ── Execute via harness (with optional timeout) ───────────────
          const maxMs = sc?.maxExecutionMs;
          const executeHarness = () =>
            this.harness.callWithChunks
              ? this.harness.callWithChunks(instruction, channelId, options, liveChunkCallback)
              : this.harness.call(instruction, channelId, options);

          let result: string;
          if (maxMs) {
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Task timed out after ${maxMs}ms`)), maxMs),
            );
            result = await Promise.race([executeHarness(), timeoutPromise]);
          } else {
            result = await executeHarness();
          }

          // Stop cancellation polling
          if (cancelCheckInterval) {
            clearInterval(cancelCheckInterval);
            cancelCheckInterval = null;
          }

          // Check if cancelled mid-execution
          if (wasCancelled || (signalPath && fs.existsSync(signalPath))) {
            wasCancelled = true;
            const partial = result.substring(0, 500);
            this.convex.deleteLiveOutput(task.taskId);
            await this.convex.updateDelegation(task._id, "cancelled", partial, "Cancelled by HQ");
            if (signalPath && fs.existsSync(signalPath)) {
              try { fs.unlinkSync(signalPath); } catch { /* ignore */ }
            }
            if (traceDb && relaySpanId && task.traceId) {
              traceDb.addSpanEvent(relaySpanId, task.traceId, "cancelled", "Cancelled by HQ signal");
              traceDb.completeSpan(relaySpanId, "cancelled");
            }
            console.log(`[${this.harness.harnessName}] Delegation: task ${task.taskId} cancelled`);
            continue;
          }

          // ── Result chunking — overflow large results ──────────────────
          let inlineResult: string;
          if (result.length > MAX_INLINE_RESULT && this.config.vaultPath) {
            try {
              const resultsDir = path.join(this.config.vaultPath, "_delegation/results");
              fs.mkdirSync(resultsDir, { recursive: true });
              const resultFile = path.join(resultsDir, `result-${task.taskId}.md`);
              fs.writeFileSync(resultFile, result, "utf-8");
              const summary = result.substring(0, 500);
              inlineResult = `${summary}\n\n[Full result: _delegation/results/result-${task.taskId}.md (${result.length} chars)]`;
            } catch {
              inlineResult = result.substring(0, MAX_INLINE_RESULT);
            }
          } else {
            inlineResult = result;
          }

          // Report success
          this.convex.deleteLiveOutput(task.taskId);
          await this.convex.updateDelegation(task._id, "completed", inlineResult);

          if (traceDb && relaySpanId && task.traceId) {
            traceDb.addSpanEvent(relaySpanId, task.traceId, "completed", `Result: ${result.length} chars`);
            traceDb.completeSpan(relaySpanId, "completed");
          }

          console.log(
            `[${this.harness.harnessName}] Delegation: task ${task.taskId} completed (${result.length} chars)`,
          );

          // Post result to Discord channel if specified
          if (task.discordChannelId && this.client) {
            try {
              const channel = await this.client.channels.fetch(task.discordChannelId);
              if (channel && "send" in channel) {
                const header = `**[HQ Delegation Result]** Task: \`${task.taskId}\`\n`;
                const chunks = chunkMessage(header + result);
                for (const chunk of chunks) {
                  await (channel as any).send(chunk);
                }
              }
            } catch (discordErr: any) {
              console.warn(
                `[${this.harness.harnessName}] Delegation: failed to post result to Discord:`,
                discordErr.message,
              );
            }
          }
        } catch (execErr: any) {
          // Stop cancellation polling
          if (cancelCheckInterval) {
            clearInterval(cancelCheckInterval);
            cancelCheckInterval = null;
          }

          if (wasCancelled || (signalPath && fs.existsSync(signalPath))) {
            // Harness threw because it was killed by cancellation
            this.convex.deleteLiveOutput(task.taskId);
            await this.convex.updateDelegation(task._id, "cancelled", undefined, "Cancelled by HQ");
            if (signalPath && fs.existsSync(signalPath)) {
              try { fs.unlinkSync(signalPath); } catch { /* ignore */ }
            }
            if (traceDb && relaySpanId && task.traceId) {
              traceDb.addSpanEvent(relaySpanId, task.traceId, "cancelled", "Cancelled by HQ signal");
              traceDb.completeSpan(relaySpanId, "cancelled");
            }
            console.log(`[${this.harness.harnessName}] Delegation: task ${task.taskId} cancelled (harness killed)`);
          } else {
            this.convex.deleteLiveOutput(task.taskId);
            await this.convex.updateDelegation(
              task._id,
              "failed",
              undefined,
              execErr.message || String(execErr),
            );
            if (traceDb && relaySpanId && task.traceId) {
              traceDb.addSpanEvent(relaySpanId, task.traceId, "failed", execErr.message || String(execErr));
              traceDb.completeSpan(relaySpanId, "failed");
            }
            console.error(
              `[${this.harness.harnessName}] Delegation: task ${task.taskId} failed:`,
              execErr.message,
            );
          }
        } finally {
          this.setBotPresence("online");
          if (traceDb) {
            try { traceDb.close(); } catch { /* ignore */ }
          }
        }
      }
    } catch (err: any) {
      // Silently ignore polling errors — will retry on next interval
    } finally {
      this.isDelegating = false;
    }
  }

  private setBotPresence(status: "online" | "busy" | "offline"): void {
    if (!this.client?.user) return;

    const presenceMap = {
      online: {
        status: PresenceUpdateStatus.Online,
        activity: { name: "Ready for messages", type: ActivityType.Listening },
      },
      busy: {
        status: PresenceUpdateStatus.DoNotDisturb,
        activity: { name: "Processing message...", type: ActivityType.Playing },
      },
      offline: {
        status: PresenceUpdateStatus.Invisible,
        activity: { name: "Offline", type: ActivityType.Playing },
      },
    } as const;

    const p = presenceMap[status];
    this.client.user.setPresence({
      status: p.status,
      activities: [{ name: p.activity.name, type: p.activity.type }],
    });

    const heartbeatMeta = {
      type: "discord-relay",
      name: `Discord Relay (${this.harness.harnessName})`,
      harnessType: this.harnessType,
      capabilities: this.getCapabilities(),
    };
    this.convex.sendHeartbeat(this.agentId, status, heartbeatMeta).catch(() => {});
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (message.author.id !== this.config.discordUserId) return;

    if (this.processedMessages.has(message.id)) return;
    this.processedMessages.add(message.id);
    if (this.processedMessages.size > MAX_DEDUP_SIZE) {
      const first = this.processedMessages.values().next().value!;
      this.processedMessages.delete(first);
    }

    const isDM = message.channel.type === ChannelType.DM;
    const isBotMentioned = this.config.discordBotId
      ? message.content.includes(`<@${this.config.discordBotId}>`)
      : false;

    if (!isDM && !isBotMentioned) return;

    let content = message.content.trim();
    if (this.config.discordBotId) {
      content = content
        .replace(new RegExp(`<@!?${this.config.discordBotId}>`, "g"), "")
        .trim();
    }

    // Voice message transcription
    const isVoiceMessage = message.flags.has(MessageFlags.IsVoiceMessage);
    if (isVoiceMessage) {
      if (!this.transcriber) {
        await message.reply(
          "Voice messages are not configured. Set `VOICE_PROVIDER=groq` and `GROQ_API_KEY` in your .env.local.",
        );
        return;
      }

      const audioAttachment = message.attachments.find(
        (a) => a.contentType?.startsWith("audio/") ?? false,
      );
      if (!audioAttachment) {
        await message.reply("Voice message received but no audio attachment found.");
        return;
      }

      try {
        await mkdir(this.config.uploadsDir, { recursive: true });
        const audioPath = join(this.config.uploadsDir, `${Date.now()}_voice.ogg`);
        const audioResponse = await fetch(audioAttachment.url);
        const buffer = Buffer.from(await audioResponse.arrayBuffer());
        await writeFile(audioPath, buffer);

        const result = await this.transcriber.transcribe(audioPath);
        await unlink(audioPath).catch(() => {});

        if (!result.text) {
          await message.reply("Could not transcribe voice message (empty result).");
          return;
        }

        const durationLabel = result.durationSecs
          ? ` (${result.durationSecs.toFixed(1)}s)`
          : "";
        console.log(
          `[Voice] Transcribed via ${result.provider}${durationLabel}: ${result.text.substring(0, 80)}...`,
        );

        content = content
          ? `${content}\n\n[Voice message]: ${result.text}`
          : result.text;
      } catch (err: any) {
        console.error("[Voice] Transcription error:", err.message);
        await message.reply(`Voice transcription failed: ${err.message}`);
        return;
      }
    }

    if (!content && message.attachments.size === 0) return;

    // Handle commands
    try {
      const cmdResult = await handleCommand(content, message.channelId, this.harness, this.config, this.convex);
      if (cmdResult.handled) {
        if (cmdResult.file) {
          await message.reply({
            content: cmdResult.response,
            files: [{ attachment: cmdResult.file.buffer, name: cmdResult.file.name }],
          });
        } else if (cmdResult.response) {
          await message.reply(cmdResult.response);
        }
        return;
      }
    } catch (cmdErr: any) {
      console.error("[Command] Error:", cmdErr.message);
      await message.reply(`Command error: ${cmdErr.message}`);
      return;
    }

    // Instant responses
    const classification = classifyIntent(content);
    if (classification.tier === "instant" && classification.instantResponse) {
      await message.reply(classification.instantResponse);
      return;
    }

    const isContinue =
      content.startsWith("!continue ") || content.startsWith("!c ");
    if (isContinue) {
      content = content.replace(/^!(continue|c)\s+/, "").trim();
    }

    this.setBotPresence("busy");

    const sendTyping = () => {
      if (message.channel && "sendTyping" in message.channel) {
        (message.channel as any).sendTyping().catch(() => {});
      }
    };
    sendTyping();
    const typingInterval = setInterval(sendTyping, 8000);

    try {
      const filePaths = await this.downloadAttachments(message, { skipVoiceAudio: isVoiceMessage });

      let promptText = content;
      if (filePaths.length > 0) {
        promptText =
          filePaths.map((p) => `[Attached file: ${p}]`).join("\n") +
          "\n\n" +
          content;
      }

      // Resolve reply-to context: if the user replied to a specific prior message,
      // fetch that message's content so the agent knows exactly what they're responding to.
      let replyToContent: string | undefined;
      if (message.reference?.messageId) {
        try {
          const refMsg = await message.channel.messages.fetch(message.reference.messageId);
          if (refMsg && refMsg.content) {
            replyToContent = refMsg.content.length > 1200
              ? refMsg.content.substring(0, 1200) + "..."
              : refMsg.content;
          }
        } catch {
          // Non-fatal — reference may have been deleted or unavailable
        }
      }

      // Build enriched prompt BEFORE saving user message to avoid duplication:
      // getRecentMessages() reads from disk, so saving first would include
      // the current message in both the conversation history AND as the prompt.
      const enrichedPrompt = await this.enricher.buildPrompt(promptText, message.channelId, replyToContent);

      await this.convex.saveMessage("user", content, message.channelId);

      // Split: stable system instruction goes through --append-system-prompt,
      // dynamic context stays in the user prompt (-p)
      const systemInstruction = this.enricher.buildSystemInstruction();
      const rawResponse = await this.harness.call(enrichedPrompt, message.channelId, {
        filePaths,
        continueSession: isContinue,
        channelSettings: {
          systemPrompt: systemInstruction,
        },
      });

      const response = await processMemoryIntents(this.convex, rawResponse);

      await this.convex.saveMessage("assistant", response, message.channelId);

      const chunks = chunkMessage(response, 2000);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }

      for (const fp of filePaths) {
        await unlink(fp).catch(() => {});
      }
    } catch (error: any) {
      console.error("Message handling error:", error);
      await message.reply(
        "An error occurred while processing your message. Check relay logs.",
      );
    } finally {
      clearInterval(typingInterval);
      this.setBotPresence("online");
    }
  }

  private async downloadAttachments(
    message: Message,
    opts?: { skipVoiceAudio?: boolean },
  ): Promise<string[]> {
    const paths: string[] = [];
    if (message.attachments.size === 0) return paths;

    await mkdir(this.config.uploadsDir, { recursive: true });

    for (const [, attachment] of message.attachments) {
      if (opts?.skipVoiceAudio && attachment.contentType?.startsWith("audio/")) {
        continue;
      }

      try {
        const response = await fetch(attachment.url);
        const buffer = Buffer.from(await response.arrayBuffer());
        const filePath = join(
          this.config.uploadsDir,
          `${Date.now()}_${attachment.name || "file"}`,
        );
        await writeFile(filePath, buffer);
        paths.push(filePath);
      } catch (err: any) {
        console.warn(`Failed to download attachment: ${err.message}`);
      }
    }

    return paths;
  }
}

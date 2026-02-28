import {
  MessageFlags,
  type Message,
  type Interaction,
} from "discord.js";
import { writeFile, unlink, mkdir } from "fs/promises";
import * as fs from "fs";
import * as path from "path";
import { join } from "path";
import {
  DiscordBotBase,
  chunkMessage,
  classifyIntent,
  StreamingReply,
  ThreadManager,
  extractFileAttachments,
  buildAttachments,
  type IncomingMessage,
} from "@repo/discord-core";
import type { BaseHarness } from "./harnesses/base.js";
import { ContextEnricher } from "./context.js";
import { VaultAPI as ConvexAPI } from "./vaultApi.js";
import { processMemoryIntents } from "./memory.js";
import { handleCommand } from "./commands.js";
import { createTranscriber, type Transcriber } from "./transcribe.js";
import { getSlashCommandDefs, handleSlashCommand, handleAutocomplete } from "./slashCommands.js";
import type { RelayConfig } from "./types.js";

const MAX_INLINE_RESULT = 8000;

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
 * Extends DiscordBotBase for shared client setup, dedup, auth, presence.
 */
export class BotInstance extends DiscordBotBase {
  private harness: BaseHarness;
  private enricher: ContextEnricher;
  private convex: ConvexAPI;
  private relayConfig: RelayConfig;
  private transcriber: Transcriber | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private delegationInterval: ReturnType<typeof setInterval> | null = null;
  private isDelegating = false;
  private agentId: string;
  private harnessType: string;
  private syncCleanup: (() => void) | null = null;
  private threadManager = new ThreadManager();
  private sharedSync: any | null = null;

  constructor(config: RelayConfig, harness: BaseHarness, sharedSync?: any) {
    super({
      config: {
        botToken: config.discordBotToken,
        userId: config.discordUserId,
        botId: config.discordBotId,
      },
      label: harness.harnessName,
      presence: {
        onlineText: "Ready for messages",
        busyText: "Processing message...",
      },
    });

    this.relayConfig = config;
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
    this.transcriber = createTranscriber(this.relayConfig);

    // Start the base class (client creation, login, event listeners)
    await super.start();

    // Heartbeat registration
    const capabilities = this.getCapabilities();
    const heartbeatMeta = {
      type: "discord-relay",
      name: `Discord Relay (${this.harness.harnessName})`,
      harnessType: this.harnessType,
      capabilities,
    };
    await this.convex.sendHeartbeat(this.agentId, "online", heartbeatMeta);
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
    await super.stop();
  }

  // ── DiscordBotBase hooks ──────────────────────────────────────────

  async onReady(): Promise<void> {
    // Register slash commands via the relay's existing module
    try {
      const defs = getSlashCommandDefs(this.harness.harnessName);
      const client = this.getClient();
      if (client?.application) {
        await client.application.commands.set(
          defs.map((d) => d.data.toJSON()),
        );
        console.log(`[${this.harness.harnessName}] Registered ${defs.length} slash commands`);
      }
    } catch (err: any) {
      console.error(`[${this.harness.harnessName}] Failed to register slash commands:`, err.message);
    }
  }

  /** Handle slash commands and autocomplete via relay's existing system. */
  protected async onInteraction(interaction: Interaction): Promise<boolean> {
    if (interaction.isChatInputCommand()) {
      if (!this.isInteractionAuthorized(interaction.user.id)) {
        await interaction.reply({ content: "Unauthorized.", ephemeral: true });
        return true;
      }
      await handleSlashCommand(interaction, {
        harness: this.harness,
        config: this.relayConfig,
        convex: this.convex,
        enricher: this.enricher,
        threadManager: this.threadManager,
      });
      return true;
    } else if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction, this.harness);
      return true;
    }
    return false;
  }

  /** Handle incoming authorized, deduplicated, mention-stripped messages. */
  async onMessage(msg: IncomingMessage): Promise<void> {
    const message = msg.message;
    let content = msg.content;

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
        await mkdir(this.relayConfig.uploadsDir, { recursive: true });
        const audioPath = join(this.relayConfig.uploadsDir, `${Date.now()}_voice.ogg`);
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
      const cmdResult = await handleCommand(content, message.channelId, this.harness, this.relayConfig, this.convex);
      if (cmdResult.handled) {
        const trimmedCmd = content.trim().toLowerCase();
        if (trimmedCmd === "!reset" || trimmedCmd === "!new" || trimmedCmd === "!clear" || trimmedCmd === "!defaults") {
          this.threadManager.clearThread(message.channelId);
        }

        const replyOpts: Record<string, unknown> = {};
        if (cmdResult.embed) replyOpts.embeds = [cmdResult.embed];
        if (cmdResult.response) replyOpts.content = cmdResult.response;
        if (cmdResult.file) replyOpts.files = [{ attachment: cmdResult.file.buffer, name: cmdResult.file.name }];
        if (replyOpts.embeds || replyOpts.content || replyOpts.files) {
          await message.reply(replyOpts);
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

    this.updatePresenceAndHeartbeat("busy");

    // Show Discord typing indicator (the "... is typing" animation)
    this.startTyping("harness", message.channelId);

    // Track message for auto-threading
    this.threadManager.trackMessage(message.channelId);

    const streaming = new StreamingReply(message);
    let streamingStarted = false;

    try {
      const filePaths = await this.downloadAttachments(message, { skipVoiceAudio: isVoiceMessage });

      let promptText = content;
      if (filePaths.length > 0) {
        promptText =
          filePaths.map((p) => `[Attached file: ${p}]`).join("\n") +
          "\n\n" +
          content;
      }

      // Resolve reply-to context
      let replyToContent: string | undefined;
      if (message.reference?.messageId) {
        try {
          const refMsg = await message.channel.messages.fetch(message.reference.messageId);
          if (refMsg) {
            // Bot streaming replies may have empty .content but text in embeds or description
            const text = refMsg.content ||
              refMsg.embeds?.[0]?.description ||
              refMsg.embeds?.[0]?.fields?.map(f => `${f.name}: ${f.value}`).join("\n") ||
              "";
            if (text) {
              const authorLabel = refMsg.author?.bot ? "Bot" : (refMsg.author?.username ?? "User");
              const snippet = text.length > 1200 ? text.substring(0, 1200) + "..." : text;
              replyToContent = `[${authorLabel}]: ${snippet}`;
            }
          }
        } catch {
          // Non-fatal
        }
      }

      const enrichedPrompt = await this.enricher.buildPrompt(promptText, message.channelId, replyToContent);
      await this.convex.saveMessage("user", content, message.channelId);

      await streaming.start();
      streamingStarted = true;

      const systemInstruction = this.enricher.buildSystemInstruction();
      const callOptions = {
        filePaths,
        continueSession: isContinue,
        channelSettings: {
          systemPrompt: systemInstruction,
        },
      };

      let rawResponse: string;
      if (this.harness.callWithChunks) {
        rawResponse = await this.harness.callWithChunks(
          enrichedPrompt,
          message.channelId,
          callOptions,
          (chunk) => streaming.append(chunk),
        );
      } else {
        rawResponse = await this.harness.call(enrichedPrompt, message.channelId, callOptions);
      }

      console.log(`[${this.harness.harnessName}] Claude responded (${rawResponse.length} chars), processing...`);
      const response = await processMemoryIntents(this.convex, rawResponse);
      const { cleanText, files } = extractFileAttachments(response);
      await this.convex.saveMessage("assistant", cleanText, message.channelId);

      if (files.length > 0) {
        console.log(`[${this.harness.harnessName}] Found ${files.length} file marker(s):`, files.map(f => f.path));
      }

      await streaming.finish(cleanText);
      console.log(`[${this.harness.harnessName}] Text response delivered to Discord`);

      // Send any file attachments the AI included via [FILE: /path] markers
      // Non-blocking: don't let file send failures prevent the text response
      if (files.length > 0) {
        try {
          const attachments = buildAttachments(files);
          if (attachments.length > 0) {
            console.log(`[${this.harness.harnessName}] Uploading ${attachments.length} file(s) to Discord...`);
            await this.sendFile(message.channelId, attachments);
            console.log(`[${this.harness.harnessName}] File upload complete`);
          } else {
            console.log(`[${this.harness.harnessName}] No valid files to upload (all skipped)`);
          }
        } catch (fileErr: any) {
          console.error(`[${this.harness.harnessName}] File upload failed (text was delivered):`, fileErr.message);
        }
      }

      for (const fp of filePaths) {
        await unlink(fp).catch(() => {});
      }
    } catch (error: any) {
      console.error("Message handling error:", error);
      if (streamingStarted) {
        await streaming.error("An error occurred while processing your message. Check relay logs.");
      } else {
        await message.reply("An error occurred while processing your message. Check relay logs.");
      }
    } finally {
      this.stopTyping("harness");
      if (!streamingStarted) streaming.dispose();
      this.updatePresenceAndHeartbeat("online");
    }
  }

  // ── Private helpers ───────────────────────────────────────────────

  /** Update both Discord presence (via base) and vault heartbeat. */
  private updatePresenceAndHeartbeat(status: "online" | "busy" | "offline"): void {
    this.setPresence(status);
    const heartbeatMeta = {
      type: "discord-relay",
      name: `Discord Relay (${this.harness.harnessName})`,
      harnessType: this.harnessType,
      capabilities: this.getCapabilities(),
    };
    this.convex.sendHeartbeat(this.agentId, status, heartbeatMeta).catch(() => {});
  }

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

  private async initSyncDelegation(): Promise<void> {
    const sync = this.sharedSync;
    if (sync?.on) {
      try {
        const unsub = sync.on("task:created", () => {
          this.checkPendingDelegations();
        });
        this.syncCleanup = () => unsub();
        this.delegationInterval = setInterval(() => this.checkPendingDelegations(), 30_000);
        console.log(`[${this.harness.harnessName}] Using shared sync engine — event-driven delegation with 30s fallback`);
        return;
      } catch (err) {
        console.warn(`[${this.harness.harnessName}] Could not subscribe to shared sync:`, err);
      }
    }

    try {
      const { VaultSync } = await import("@repo/vault-sync");
      const vaultPath = this.relayConfig.vaultPath;
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
      console.warn(`[${this.harness.harnessName}] Sync engine not available, using 5s polling:`, err);
      this.delegationInterval = setInterval(() => this.checkPendingDelegations(), 5000);
    }
  }

  private async checkPendingDelegations(): Promise<void> {
    if (this.isDelegating) return;

    try {
      const tasks = await this.convex.getPendingDelegations(this.agentId, this.harnessType);
      if (tasks.length === 0) return;

      this.isDelegating = true;

      for (const task of tasks) {
        console.log(
          `[${this.harness.harnessName}] Delegation: claiming task ${task.taskId} (${task.instruction.substring(0, 60)}...)`,
        );

        const claimed = await this.convex.claimDelegation(task._id, this.agentId);
        if (!claimed) {
          console.log(`[${this.harness.harnessName}] Delegation: task ${task.taskId} already claimed by another relay`);
          continue;
        }

        await this.convex.updateDelegation(task._id, "running");
        this.updatePresenceAndHeartbeat("busy");

        let traceDb: any = null;
        let relaySpanId: string | null = null;
        if (task.traceId && this.relayConfig.vaultPath) {
          try {
            const { TraceDB } = await import("@repo/vault-client/trace");
            traceDb = new TraceDB(this.relayConfig.vaultPath);
            relaySpanId = traceDb.createSpan({
              traceId: task.traceId,
              parentSpanId: task.spanId,
              taskId: task.taskId,
              type: "relay_exec",
              name: `${this.harnessType}:${task.taskId}`,
            });
            traceDb.addSpanEvent(relaySpanId, task.traceId, "claimed", `Claimed by ${this.agentId}`);
          } catch {
            traceDb = null;
            relaySpanId = null;
          }
        }

        const signalsDir = this.relayConfig.vaultPath
          ? path.join(this.relayConfig.vaultPath, "_delegation/signals")
          : null;
        const signalPath = signalsDir
          ? path.join(signalsDir, `cancel-${task.taskId}.md`)
          : null;

        if (signalPath && fs.existsSync(signalPath)) {
          try { fs.unlinkSync(signalPath); } catch { /* ignore */ }
        }

        let cancelCheckInterval: ReturnType<typeof setInterval> | null = null;
        let wasCancelled = false;

        try {
          let instruction = task.instruction;
          const sc = task.securityConstraints;
          if (sc) {
            const lines: string[] = ["SECURITY CONSTRAINTS (enforced — violation will fail the task):"];
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

          const liveChunkCallback = (chunk: string) => {
            this.convex.writeLiveChunk(task.taskId, this.agentId, chunk);
          };

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

          if (cancelCheckInterval) {
            clearInterval(cancelCheckInterval);
            cancelCheckInterval = null;
          }

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

          let inlineResult: string;
          if (result.length > MAX_INLINE_RESULT && this.relayConfig.vaultPath) {
            try {
              const resultsDir = path.join(this.relayConfig.vaultPath, "_delegation/results");
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
          if (task.discordChannelId) {
            const header = `**[HQ Delegation Result]** Task: \`${task.taskId}\`\n`;
            await this.sendMessage(task.discordChannelId, header + result);
          }
        } catch (execErr: any) {
          if (cancelCheckInterval) {
            clearInterval(cancelCheckInterval);
            cancelCheckInterval = null;
          }

          if (wasCancelled || (signalPath && fs.existsSync(signalPath))) {
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
          this.updatePresenceAndHeartbeat("online");
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

  private async downloadAttachments(
    message: Message,
    opts?: { skipVoiceAudio?: boolean },
  ): Promise<string[]> {
    const paths: string[] = [];
    if (message.attachments.size === 0) return paths;

    await mkdir(this.relayConfig.uploadsDir, { recursive: true });

    for (const [, attachment] of message.attachments) {
      if (opts?.skipVoiceAudio && attachment.contentType?.startsWith("audio/")) {
        continue;
      }

      try {
        const response = await fetch(attachment.url);
        const buffer = Buffer.from(await response.arrayBuffer());
        const filePath = join(
          this.relayConfig.uploadsDir,
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

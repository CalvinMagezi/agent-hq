/**
 * RelayWhatsAppBot — Routes WhatsApp self-chat messages through the relay server.
 *
 * Pattern mirrors RelayDiscordBot (apps/relay-adapter-discord/src/bot.ts).
 * Connects WhatsAppBridge events to the agent relay server via RelayClient.
 */

import { RelayClient } from "@repo/agent-relay-protocol";
import type {
  RelayClientConfig,
  CmdResultMessage,
  ChatDeltaMessage,
  ChatFinalMessage,
} from "@repo/agent-relay-protocol";
import type { WhatsAppBridge, WhatsAppMessage } from "./whatsapp.js";
import type { WhatsAppGuard } from "./guard.js";
import type { VoiceHandler } from "./voice.js";
import { detectIntent } from "./orchestrator.js";

/** Max chars per WhatsApp message for readability. */
const MAX_CHUNK_SIZE = 4000;

/** Extract a human-readable harness label from a delegation task file path. */
function harness_from_path(filePath: string): string | null {
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
  /** Optional voice handler for transcription + TTS. Requires OPENAI_API_KEY. */
  voiceHandler?: VoiceHandler;
}

export class RelayWhatsAppBot {
  private relay: RelayClient;
  private bridge: WhatsAppBridge;
  private guard: WhatsAppGuard;
  private voiceHandler: VoiceHandler | null;
  private voiceReplyEnabled = false;
  private processedMessages = new Set<string>();
  private threadId: string | null = null;
  private modelOverride: string | undefined;
  private processing = false;
  private messageQueue: WhatsAppMessage[] = [];
  /** Active orchestration job tracking */
  private activeJobId: string | null = null;
  private activeJobLabel: string | null = null;
  private activeJobResultDelivered = false;

  constructor(config: RelayWhatsAppBotConfig) {
    this.guard = config.guard;
    this.bridge = config.bridge;
    this.voiceHandler = config.voiceHandler ?? null;

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

    // Start the WhatsApp bridge
    await this.bridge.start();
    console.log(
      "[relay-whatsapp] WhatsApp bridge started — listening for self-chat messages",
    );
  }

  async stop(): Promise<void> {
    this.relay.disconnect();
    await this.bridge.stop();
    console.log("[relay-whatsapp] Bot stopped");
  }

  private async handleMessage(msg: WhatsAppMessage): Promise<void> {
    console.log(
      `[relay-whatsapp] handleMessage called: id=${msg.id}, content="${msg.content.substring(0, 60)}", fromMe=${msg.fromMe}`,
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

    // ── Voice note handling ─────────────────────────────────────
    if (msg.isVoiceNote) {
      if (!this.voiceHandler) {
        await this.bridge.sendMessage(
          "Voice notes received but transcription is not configured.\n" +
            "Set OPENAI_API_KEY in .env.local to enable voice note support.",
        );
        return;
      }
      if (!msg.audioBuffer) {
        await this.bridge.sendMessage("Received a voice note but failed to download the audio.");
        return;
      }
      try {
        console.log("[relay-whatsapp] Transcribing voice note...");
        await this.bridge.sendTyping();
        const transcript = await this.voiceHandler.transcribe(msg.audioBuffer);
        if (!transcript) {
          await this.bridge.sendMessage("I received your voice note but couldn't make out what was said.");
          return;
        }
        console.log(`[relay-whatsapp] Voice note transcribed: "${transcript.substring(0, 80)}"`);
        // Route transcript as a regular chat message with a prefix
        await this.handleChat(`[Voice note]: ${transcript}`);
        await this.processQueue();
        return;
      } catch (err) {
        console.error("[relay-whatsapp] Transcription failed:", err);
        await this.bridge.sendMessage(
          `Failed to transcribe voice note: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
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

    // ── ! Commands ─────────────────────────────────────────────────
    if (content.startsWith("!")) {
      console.log(`[relay-whatsapp] Processing command: ${content}`);
      await this.handleBangCommand(content);
      return;
    }

    // ── Intent-based routing ────────────────────────────────────────
    const { intent, harness } = detectIntent(content);
    console.log(`[relay-whatsapp] Intent: ${intent}, harness: ${harness}`);

    if (intent !== "general" && !this.modelOverride) {
      // Delegate to the appropriate Discord bot via vault delegation
      console.log(`[relay-whatsapp] Delegating to ${harness}: "${content.substring(0, 60)}"`);
      await this.handleDelegation(content, harness);
    } else {
      // General chat or user has explicitly set a model override
      console.log(
        `[relay-whatsapp] Processing chat message: "${content.substring(0, 60)}"`,
      );
      await this.handleChat(content);
    }

    // Process any queued messages
    await this.processQueue();
  }

  private async processQueue(): Promise<void> {
    while (this.messageQueue.length > 0) {
      const queuedMsg = this.messageQueue.shift()!;
      const content = queuedMsg.content.trim();
      if (!content) continue;

      console.log(
        `[relay-whatsapp] Processing queued message: "${content.substring(0, 40)}"`,
      );

      if (content.startsWith("!")) {
        await this.handleBangCommand(content);
      } else {
        await this.handleChat(content);
      }
    }
  }

  private async handleBangCommand(content: string): Promise<void> {
    const parts = content.slice(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const argStr = parts.slice(1).join(" ").trim();

    let command: string;
    let args: Record<string, unknown> = {};

    switch (cmd) {
      case "reset":
      case "new":
        command = "reset";
        this.threadId = null;
        this.modelOverride = undefined;
        await this.bridge.sendMessage("Session reset.");
        return;
      case "model":
        if (argStr) {
          this.modelOverride = argStr;
          await this.bridge.sendMessage(`Model set to: ${argStr}`);
          return;
        }
        // No arg: ask relay for actual active model name
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
        await this.bridge.sendMessage(
          "Model set to: claude-haiku-4-5-20251001",
        );
        return;
      case "gemini":
        this.modelOverride = "google/gemini-2.5-flash-preview-05-20";
        await this.bridge.sendMessage(
          "Switched to Gemini 2.5 Flash (via OpenRouter).\n\n" +
          "_Note: This uses Gemini for general reasoning. For Google Workspace tasks (Docs, Drive, Gmail, Calendar), " +
          "use the Gemini bot on Discord — it has full authenticated Workspace access._",
        );
        return;
      case "status":
      case "hq":
        if (this.activeJobId) {
          const label = this.activeJobLabel ?? "task";
          await this.bridge.sendMessage(
            `*Active task:* ${label}\n` +
            `Job ID: \`${this.activeJobId}\`\n` +
            `Status: running — waiting for result`,
          );
        } else {
          command = "status";
        }
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
        if (argStr === "on") {
          if (!this.voiceHandler) {
            await this.bridge.sendMessage(
              "Voice reply not available — set OPENAI_API_KEY in .env.local to enable.",
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
          const voiceAvail = this.voiceHandler ? "available" : "not configured (set OPENAI_API_KEY)";
          await this.bridge.sendMessage(
            `*Voice settings*\n\nTranscription: ${voiceAvail}\nReply mode: ${voiceStatus}\n\n!voice on — respond with voice notes\n!voice off — respond with text`,
          );
        }
        return;
      case "help":
      case "commands":
        await this.bridge.sendMessage(
          "*WhatsApp HQ Commands*\n\n" +
            "!reset — Start new conversation\n" +
            "!model — Show active model\n" +
            "!model <name> — Set model by ID\n" +
            "!opus / !sonnet / !haiku — Quick Claude model switch\n" +
            "!gemini — Switch to Gemini 2.5 Flash\n" +
            "!status — HQ agent status / active task status\n" +
            "!memory — Show memory\n" +
            "!search <query> — Search vault\n" +
            "!voice [on|off] — Toggle voice note replies\n" +
            "!help — This message\n\n" +
            "_Workspace tasks (calendar, gmail, drive) auto-route to Gemini bot_\n" +
            "_Coding tasks (git, debug, refactor) auto-route to Claude Code bot_",
        );
        return;
      default:
        await this.bridge.sendMessage(`Unknown command: !${cmd}. Try !help.`);
        return;
    }

    // Execute relay command
    try {
      console.log(`[relay-whatsapp] Sending command to relay: ${command}`);
      const result = await new Promise<string>((resolve, reject) => {
        const requestId = `wa-cmd-${Date.now()}`;
        const unsub = this.relay.on<CmdResultMessage>(
          "cmd:result",
          (cmdMsg) => {
            if (cmdMsg.requestId === requestId) {
              unsub();
              console.log(
                `[relay-whatsapp] Command result received: success=${cmdMsg.success}`,
              );
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

  /**
   * Route a task through the HQ agent → Discord harness delegation pipeline.
   * Submits a job to the HQ agent and tracks result via vault events.
   * Falls back to direct OpenRouter chat if agent is unavailable.
   */
  private async handleDelegation(
    content: string,
    harness: "gemini-cli" | "claude-code" | "any",
  ): Promise<void> {
    this.processing = true;
    const harnessLabel =
      harness === "gemini-cli" ? "Gemini (Google Workspace)" :
      harness === "claude-code" ? "Claude Code" : "HQ";

    try {
      await this.bridge.sendMessage(`_Routing to ${harnessLabel}..._`);

      // Submit job to HQ agent with explicit delegation instruction
      const instruction =
        `[WHATSAPP_ORCHESTRATION targetHarness=${harness}]\n\n` +
        `${content}\n\n` +
        `Use the delegate_to_relay tool to handle this task via ${harness}. ` +
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

      // Result is delivered via handleVaultEvent when job:completed fires.
      // Set a 10-min failsafe — fall back to direct chat if nothing arrives.
      setTimeout(async () => {
        if (this.activeJobId === jobId && !this.activeJobResultDelivered) {
          console.warn(`[relay-whatsapp] Job ${jobId} timed out — falling back to direct chat`);
          this.activeJobId = null;
          this.activeJobLabel = null;
          this.processing = false;
          await this.bridge.sendMessage(`_${harnessLabel} didn't respond in time. Answering directly..._`);
          await this.handleChat(content);
        }
      }, 10 * 60 * 1000);

    } catch (err) {
      console.error("[relay-whatsapp] Delegation setup error:", err);
      this.activeJobId = null;
      this.activeJobLabel = null;
      this.processing = false;
      await this.bridge.sendMessage(`_${harnessLabel} unavailable — answering directly..._`);
      await this.handleChat(content);
    }
    // Note: processing stays true until handleVaultEvent delivers the result or timeout fires.
  }

  /** Handle vault file-system events forwarded by the relay server. */
  private async handleVaultEvent(event: string, data?: any): Promise<void> {
    // Extract identifiers from file path (e.g. "_delegation/claimed/task-wa-123.md")
    const filePath: string = data?.path ?? data?.filePath ?? "";
    const taskIdMatch = filePath.match(/task-([^/]+?)\.md$/);
    const taskId = taskIdMatch?.[1] ?? null;

    // Extract jobId from path (e.g. "_jobs/done/job-1234-abc.md")
    const jobIdMatch = filePath.match(/job-([^/]+?)\.md$/);
    const fileJobId = jobIdMatch ? `job-${jobIdMatch[1]}` : null;

    switch (event) {
      case "task:created":
        if (this.activeJobId) {
          console.log(`[relay-whatsapp] Task created: ${taskId} for job ${this.activeJobId}`);
        }
        break;

      case "task:claimed":
        if (this.activeJobId) {
          const claimedBy = data?.claimedBy ?? (harness_from_path(filePath) ?? "a bot");
          await this.bridge.sendMessage(`_${claimedBy} is now working on your request..._`);
        }
        break;

      case "task:completed":
        if (this.activeJobId && taskId && !this.activeJobResultDelivered) {
          console.log(`[relay-whatsapp] Task completed: ${taskId} — fetching result`);
          const result = await this.fetchTaskResult(taskId);
          if (result) {
            this.activeJobResultDelivered = true;
            this.activeJobId = null;
            this.activeJobLabel = null;
            this.processing = false;
            await this.sendChunked(result);
          }
        }
        break;

      case "job:completed":
        if (this.activeJobId && (fileJobId === this.activeJobId) && !this.activeJobResultDelivered) {
          console.log(`[relay-whatsapp] Job completed: ${fileJobId} — fetching result`);
          const result = await this.fetchJobResult(fileJobId);
          if (result) {
            this.activeJobResultDelivered = true;
            this.activeJobId = null;
            this.activeJobLabel = null;
            this.processing = false;
            await this.sendChunked(result);
          }
        }
        break;

      case "job:failed":
        if (this.activeJobId && fileJobId === this.activeJobId && !this.activeJobResultDelivered) {
          this.activeJobResultDelivered = true;
          this.activeJobId = null;
          this.activeJobLabel = null;
          this.processing = false;
          await this.bridge.sendMessage("_The delegated task failed. Try again or rephrase._");
        }
        break;
    }
  }

  /** Extract harness label from a delegation task file path. */
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
      this.relay.send({ type: "cmd:execute", command: "task-result", args: { taskId }, requestId });
      setTimeout(() => { unsub(); resolve(null); }, 8_000);
    });
  }

  /** Fetch a completed job's result from the vault. */
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
      this.relay.send({ type: "cmd:execute", command: "job-result", args: { jobId }, requestId });
      setTimeout(() => { unsub(); resolve(null); }, 8_000);
    });
  }

  private async handleChat(content: string): Promise<void> {
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
      // Non-critical — continue even if typing fails
    }

    try {
      console.log(
        `[relay-whatsapp] Sending chat to relay: requestId=${requestId}, threadId=${this.threadId ?? "new"}`,
      );

      let buffer = "";
      let deltaCount = 0;

      const finalMsg = await new Promise<ChatFinalMessage>(
        (resolve, reject) => {
          // Register ALL listeners FIRST before sending
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
                console.log(
                  `[relay-whatsapp] chat:final received: ${msg.content?.length ?? 0} chars, threadId=${msg.threadId}`,
                );
                unsub1();
                unsub2();
                unsub3();
                resolve(msg);
              }
            },
          );

          const unsub3 = this.relay.on("error", (errMsg) => {
            if ((errMsg as any).requestId === requestId) {
              console.error(
                `[relay-whatsapp] Error from relay:`,
                (errMsg as any).message,
              );
              unsub1();
              unsub2();
              unsub3();
              reject(
                new Error((errMsg as any).message ?? "Unknown relay error"),
              );
            }
          });

          // NOW send the message — listeners are already registered
          console.log(`[relay-whatsapp] Sending chat:send to relay...`);
          try {
            this.relay.send({
              type: "chat:send",
              content,
              threadId: this.threadId ?? undefined,
              requestId,
              modelOverride: this.modelOverride,
            });
            console.log(`[relay-whatsapp] chat:send sent successfully`);
          } catch (sendErr) {
            console.error(
              `[relay-whatsapp] Failed to send chat:send:`,
              sendErr,
            );
            unsub1();
            unsub2();
            unsub3();
            reject(sendErr);
            return;
          }

          // Timeout after 10 minutes
          setTimeout(() => {
            console.error(
              `[relay-whatsapp] Request timed out after 10 minutes (received ${deltaCount} deltas, ${buffer.length} chars)`,
            );
            unsub1();
            unsub2();
            unsub3();
            reject(new Error("Request timed out (10 min)"));
          }, 10 * 60 * 1000);
        },
      );

      // Save thread ID for conversation continuity
      if (finalMsg.threadId && !this.threadId) {
        this.threadId = finalMsg.threadId;
        console.log(
          `[relay-whatsapp] Thread ID saved: ${this.threadId}`,
        );
      }

      // Stop typing before sending response
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
      }
      await this.bridge.stopTyping();

      // Send the complete response
      const responseText = finalMsg.content || buffer;
      console.log(
        `[relay-whatsapp] Response ready: ${responseText.length} chars (final: ${finalMsg.content?.length ?? 0}, buffer: ${buffer.length})`,
      );

      if (responseText.trim()) {
        if (this.voiceReplyEnabled && this.voiceHandler) {
          try {
            console.log("[relay-whatsapp] Synthesizing voice reply...");
            const audioBuffer = await this.voiceHandler.synthesize(responseText);
            await this.bridge.sendVoiceNote(audioBuffer);
            console.log("[relay-whatsapp] Voice reply sent");
          } catch (err) {
            console.error("[relay-whatsapp] TTS failed, falling back to text:", err);
            await this.sendChunked(responseText);
          }
        } else {
          await this.sendChunked(responseText);
        }
        console.log(`[relay-whatsapp] Response sent to WhatsApp`);
      } else {
        console.warn(
          `[relay-whatsapp] Empty response from relay — nothing to send`,
        );
        await this.bridge.sendMessage(
          "(No response from agent — the relay server may not have an active agent or LLM backend configured.)",
        );
      }
    } catch (err) {
      console.error("[relay-whatsapp] Chat error:", err);
      // Stop typing on error
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

  /** Split long messages into chunks and send sequentially. */
  private async sendChunked(text: string): Promise<void> {
    if (text.length <= MAX_CHUNK_SIZE) {
      await this.bridge.sendMessage(text);
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

      // Try to split at a paragraph boundary
      let splitAt = remaining.lastIndexOf("\n\n", MAX_CHUNK_SIZE);
      if (splitAt < MAX_CHUNK_SIZE / 2) {
        // No good paragraph break — split at last newline
        splitAt = remaining.lastIndexOf("\n", MAX_CHUNK_SIZE);
      }
      if (splitAt < MAX_CHUNK_SIZE / 2) {
        // No good newline — split at last space
        splitAt = remaining.lastIndexOf(" ", MAX_CHUNK_SIZE);
      }
      if (splitAt < MAX_CHUNK_SIZE / 2) {
        // Hard split
        splitAt = MAX_CHUNK_SIZE;
      }

      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt).trimStart();
    }

    console.log(
      `[relay-whatsapp] Sending ${chunks.length} chunks (total: ${text.length} chars)`,
    );
    for (const chunk of chunks) {
      await this.bridge.sendMessage(chunk);
    }
  }
}

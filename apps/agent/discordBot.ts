/**
 * Discord Bot Module for Agent-HQ Agent
 *
 * Extends DiscordBotBase for shared client setup, presence, typing, dedup.
 * Provides DM-based approval requests, job event mirroring, and chat routing.
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  type Interaction,
} from "discord.js";
import {
  DiscordBotBase,
  classifyIntent,
  chunkMessage,
  extractFileAttachments,
  buildAttachments,
  type IncomingMessage,
  type IntentRule,
} from "@repo/discord-core";
import type { ChatSessionManager } from "./lib/chatSession.js";

// --- Types ---

interface DiscordConfig {
  botToken: string;
  userId: string;
  botId?: string;
  channelId?: string;
  webhookUrl?: string;
  enablePresence?: boolean;
  presenceType?: "activity" | "custom-status";
}

interface ApprovalNotification {
  approvalId: string;
  title: string;
  description: string;
  riskLevel: string;
  toolName: string;
}

interface JobEvent {
  type: "started" | "completed" | "failed" | "cancelled";
  jobId: string;
  instruction: string;
  result?: string;
  error?: string;
}

// --- Agent-specific intent rules ---

const AGENT_INTENT_RULES: IntentRule[] = [
  {
    patterns: [/^ping$/i, /^are you there\??$/i, /^are you online\??$/i, /^are you alive\??$/i, /^yo$/i],
    response: (ctx) => `Online and ready! Working in: \`${ctx.targetDir ?? "unknown"}\``,
    reason: "ping/presence check",
  },
  {
    patterns: [/^(hi|hello|hey|sup|hola|howdy)[\s!.]*$/i],
    response: (ctx) => `Hey! I'm online and ready to help. Working in: \`${ctx.targetDir ?? "unknown"}\``,
    reason: "greeting",
  },
  {
    patterns: [/where are you/i, /what('s| is) your (working )?dir/i, /^pwd$/i, /^cwd$/i, /working directory/i, /what dir/i],
    response: (ctx) => `I'm in: \`${ctx.targetDir ?? "unknown"}\``,
    reason: "location query",
  },
  {
    patterns: [/^status\??$/i, /are you busy/i, /what are you doing/i, /what('s| is) your status/i],
    response: (ctx) => {
      if (ctx.isBusy && ctx.currentJobInstruction) {
        const instr = String(ctx.currentJobInstruction);
        return `I'm currently working on: "${instr.substring(0, 100)}${instr.length > 100 ? "..." : ""}"`;
      }
      return `Online and idle. Working directory: \`${ctx.targetDir ?? "unknown"}\``;
    },
    reason: "status query",
  },
  {
    patterns: [/what time/i, /current time/i, /what('s| is) the time/i],
    response: () => `Current time: ${new Date().toLocaleString()}`,
    reason: "time query",
  },
  {
    patterns: [/^who are you\??$/i, /worker id/i],
    response: (ctx) => `I'm HQ Agent (Worker: \`${ctx.workerId ?? "unknown"}\`), working in: \`${ctx.targetDir ?? "unknown"}\``,
    reason: "identity query",
  },
];

// --- Discord Bot Class ---

export class DiscordBot extends DiscordBotBase {
  private agentConfig: DiscordConfig;
  private apiKey: string;
  private baseUrl: string;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private jobWatcherInterval: ReturnType<typeof setInterval> | null = null;
  private trackedJobs: Map<string, { channelId: string; isDM: boolean }> = new Map();
  private sentJobs: Set<string> = new Set();
  private chatSession: ChatSessionManager | null = null;
  private agentContext: { targetDir: string; workerId: string; isBusy: boolean; currentJobInstruction?: string } = {
    targetDir: process.cwd(),
    workerId: "unknown",
    isBusy: false,
  };

  constructor(config: DiscordConfig, _convexClient: any, apiKey: string, convexUrl: string) {
    super({
      config: {
        botToken: config.botToken,
        userId: config.userId,
        botId: config.botId,
      },
      label: "HQ Agent",
      presence: {
        onlineText: "Idle — ready for tasks",
        busyText: "a task",
      },
    });

    this.agentConfig = config;
    this.apiKey = apiKey;
    this.baseUrl = convexUrl.replace(".cloud", ".site");
  }

  setChatSession(chatSession: ChatSessionManager): void {
    this.chatSession = chatSession;
  }

  setAgentContext(ctx: { targetDir: string; workerId: string; isBusy: boolean; currentJobInstruction?: string }): void {
    this.agentContext = ctx;
  }

  async start(): Promise<void> {
    if (!this.agentConfig.enablePresence) {
      // In non-presence mode, we still need a minimal gateway connection
      // for message handling, but we skip the full gateway login
      console.log("ℹ️  Discord presence disabled, using gateway for messages only");
    }

    await super.start();

    // Start polling for pending approval notifications
    this.pollInterval = setInterval(() => this.checkPendingApprovals(), 5000);
    console.log("📡 Discord bot polling for approval requests...");

    // Start watching for completed jobs
    this.jobWatcherInterval = setInterval(() => this.checkCompletedJobs(), 3000);
    console.log("👀 Discord bot watching for completed jobs...");
  }

  async stop(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.jobWatcherInterval) {
      clearInterval(this.jobWatcherInterval);
      this.jobWatcherInterval = null;
    }
    await super.stop();
  }

  async updatePresence(status: "online" | "busy" | "offline"): Promise<void> {
    this.setPresence(status);
  }

  // ── DiscordBotBase hooks ──────────────────────────────────────────

  async onMessage(msg: IncomingMessage): Promise<void> {
    const content = msg.content;
    if (!content) return;

    console.log(`💬 Discord message from ${msg.author.username}: ${content.substring(0, 100)}`);

    // --- Tier 1: Instant response (no LLM) ---
    const classification = classifyIntent(content, AGENT_INTENT_RULES, this.agentContext as unknown as Record<string, unknown>);

    if (classification.tier === "instant" && classification.instantResponse) {
      console.log(`⚡ Instant response (${classification.reason})`);
      await msg.message.reply(classification.instantResponse);
      return;
    }

    // --- Tier 2: Chat session (lightweight LLM) ---
    if (this.chatSession) {
      this.startTyping("chat", msg.channelId);

      let jobDispatched = false;
      this.chatSession.setDiscordContext({
        channelId: msg.channelId,
        isDM: msg.isDM,
        onJobDispatched: (jobId: string) => {
          jobDispatched = true;
          this.trackedJobs.set(jobId, {
            channelId: msg.channelId,
            isDM: msg.isDM,
          });
          this.startTyping(jobId, msg.channelId);
          console.log(`📋 Tracking dispatched job ${jobId} for Discord delivery`);
        },
      });

      // Fetch reply-to context if user replied to a message
      let promptText = content;
      if (msg.message.reference?.messageId) {
        try {
          const refMsg = await msg.message.channel.messages.fetch(msg.message.reference.messageId);
          if (refMsg) {
            const refText = refMsg.content ||
              refMsg.embeds?.[0]?.description ||
              refMsg.embeds?.[0]?.fields?.map((f: any) => `${f.name}: ${f.value}`).join("\n") ||
              "";
            if (refText) {
              const authorLabel = refMsg.author?.bot ? "Bot" : (refMsg.author?.username ?? "User");
              const snippet = refText.length > 1200 ? refText.substring(0, 1200) + "..." : refText;
              promptText = `[REPLYING TO ${authorLabel}]: ${snippet}\n\n[USER MESSAGE]: ${content}`;
            }
          }
        } catch {
          // Non-fatal, fall through with original content
        }
      }

      try {
        console.log(`💭 Routing to chat session...`);
        const response = await this.chatSession.handleMessage(promptText);
        this.stopTyping("chat");

        // If a job was dispatched, skip the chat response — the job watcher
        // will deliver the actual result to avoid double-responding
        if (jobDispatched) {
          console.log(`📋 Job dispatched — suppressing chat acknowledgment to avoid double response`);
          return;
        }

        // Extract any [FILE: /path] markers and send files separately
        const { cleanText, files } = extractFileAttachments(response);
        const chunks = chunkMessage(cleanText);
        for (const chunk of chunks) {
          await msg.message.reply(chunk);
        }
        if (files.length > 0) {
          const attachments = buildAttachments(files);
          if (attachments.length > 0) {
            await this.sendFile(msg.channelId, attachments);
          }
        }
        console.log(`✅ Chat response sent (${cleanText.length} chars, ${files.length} file(s))`);
        return;
      } catch (err: any) {
        this.stopTyping("chat");
        console.error(`❌ Chat session error: ${err.message}`);
      }
    }

    // --- Fallback: Create a job ---
    console.log(`📋 Falling back to job creation (chat session unavailable)`);
    try {
      const res = await fetch(`${this.baseUrl}/api/jobs/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
        },
        body: JSON.stringify({
          instruction: content,
          type: "background",
          discordChannelId: msg.channelId,
          discordIsDM: msg.isDM,
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        console.error(`Failed to create job from Discord message: ${errorText}`);
        await msg.message.reply("Failed to create job. Please try again.");
        return;
      }

      const result: any = await res.json();
      const jobId = result.jobId;

      this.trackedJobs.set(jobId, {
        channelId: msg.channelId,
        isDM: msg.isDM,
      });

      this.startTyping(jobId, msg.channelId);
      console.log(`✅ Created job ${jobId} from Discord message`);
    } catch (err: any) {
      console.error("Error creating job from Discord message:", err.message);
      await msg.message.reply("An error occurred while processing your request.");
    }
  }

  /** Handle button interactions for approval responses. */
  protected async onInteraction(interaction: Interaction): Promise<boolean> {
    if (!interaction.isButton()) return false;

    const customId = interaction.customId;
    if (customId.startsWith("approve_") || customId.startsWith("reject_")) {
      const approvalId = customId.replace(/^(approve|reject)_/, "");
      const action = customId.startsWith("approve_") ? "approve" : "reject";

      try {
        const res = await fetch(`${this.baseUrl}/api/approvals/${action}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": this.apiKey,
          },
          body: JSON.stringify({ approvalId }),
          signal: AbortSignal.timeout(10000),
        });

        if (res.ok) {
          await interaction.reply({
            content: `Approval ${action === "approve" ? "approved" : "rejected"}.`,
            ephemeral: true,
          });
        } else {
          await interaction.reply({
            content: `Failed to ${action} — the approval may have expired.`,
            ephemeral: true,
          });
        }
      } catch (err: any) {
        await interaction.reply({
          content: `Error: ${err.message}`,
          ephemeral: true,
        });
      }
      return true;
    }

    return false;
  }

  // ── Public API (kept for backward compat) ─────────────────────────

  async sendChatMessage(channelId: string, content: string): Promise<void> {
    await this.sendMessage(channelId, content);
  }

  async sendApprovalRequest(notification: ApprovalNotification): Promise<void> {
    const client = this.getClient();
    if (!client) return;

    try {
      const user = await client.users.fetch(this.agentConfig.userId);
      const dm = await user.createDM();

      const riskEmoji: Record<string, string> = {
        low: "🟢", medium: "🟡", high: "🟠", critical: "🔴",
      };

      const embed = new EmbedBuilder()
        .setTitle(`${riskEmoji[notification.riskLevel] || "⚪"} Approval Required`)
        .setDescription(notification.description)
        .setColor(this.riskColor(notification.riskLevel))
        .addFields(
          { name: "Tool", value: notification.toolName, inline: true },
          { name: "Risk Level", value: notification.riskLevel.toUpperCase(), inline: true },
          { name: "ID", value: notification.approvalId, inline: true },
        )
        .setFooter({ text: "Reply with: !approve <id> or !reject <id> <reason>" });

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`approve_${notification.approvalId}`)
          .setLabel("Approve")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`reject_${notification.approvalId}`)
          .setLabel("Reject")
          .setStyle(ButtonStyle.Danger),
      );

      await dm.send({ embeds: [embed], components: [row] });
    } catch (err: any) {
      console.error("Failed to send approval request:", err.message);
    }
  }

  async sendJobEvent(event: JobEvent): Promise<void> {
    const channelId = this.agentConfig.channelId;
    const webhookUrl = this.agentConfig.webhookUrl;

    const emoji: Record<string, string> = {
      started: "🚀", completed: "✅", failed: "❌", cancelled: "🚫",
    };

    const colorMap: Record<string, number> = {
      completed: Colors.Green,
      failed: Colors.Red,
      cancelled: Colors.Yellow,
      started: Colors.Blue,
    };

    const embed = new EmbedBuilder()
      .setTitle(`${emoji[event.type] || "ℹ️"} Job ${event.type.charAt(0).toUpperCase() + event.type.slice(1)}`)
      .setDescription(event.instruction.substring(0, 200))
      .setColor(colorMap[event.type] ?? Colors.Blue)
      .setTimestamp();

    if (event.error) {
      embed.addFields({ name: "Error", value: event.error.substring(0, 200) });
    }

    if (webhookUrl) {
      try {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embeds: [embed.toJSON()] }),
        });
      } catch (err: any) {
        console.warn("Discord webhook send failed:", err.message);
      }
    } else if (channelId) {
      await this.sendEmbed(channelId, embed);
    }
  }

  async sendProgressMessage(content: string, embed?: {
    title: string;
    description: string;
    color: number;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    timestamp?: string;
  }): Promise<void> {
    const channelId = this.agentConfig.channelId;
    const webhookUrl = this.agentConfig.webhookUrl;

    if (!channelId && !webhookUrl) return;

    if (embed) {
      const discordEmbed = new EmbedBuilder()
        .setTitle(embed.title)
        .setDescription(embed.description)
        .setColor(embed.color)
        .setTimestamp(embed.timestamp ? new Date(embed.timestamp) : new Date());

      if (embed.fields) {
        embed.fields.forEach((f) =>
          discordEmbed.addFields({ name: f.name, value: f.value, inline: f.inline }),
        );
      }

      if (webhookUrl) {
        try {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ embeds: [discordEmbed.toJSON()] }),
          });
        } catch (err: any) {
          console.warn("Discord webhook progress message failed:", err.message);
        }
      } else if (channelId) {
        await this.sendEmbed(channelId, discordEmbed);
      }
    } else if (content) {
      if (webhookUrl) {
        try {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
          });
        } catch (err: any) {
          console.warn("Discord webhook progress message failed:", err.message);
        }
      } else if (channelId) {
        await this.sendMessage(channelId, content);
      }
    }
  }

  // ── Internal ──────────────────────────────────────────────────────

  private async checkCompletedJobs(): Promise<void> {
    try {
      const now = Date.now();
      const STUCK_JOB_TIMEOUT = 5 * 60 * 1000;

      for (const [jobId, context] of this.trackedJobs.entries()) {
        try {
          const res = await fetch(`${this.baseUrl}/api/jobs/status`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-Key": this.apiKey,
            },
            body: JSON.stringify({ jobId }),
            signal: AbortSignal.timeout(10000),
          });

          if (!res.ok) {
            if (res.status === 404) {
              this.trackedJobs.delete(jobId);
            }
            continue;
          }

          const data: any = await res.json();
          if (!data.ok) continue;

          if (data.status === "pending" && data.createdAt) {
            const age = now - data.createdAt;
            if (age > STUCK_JOB_TIMEOUT) {
              this.stopTyping(jobId);
              await this.sendMessage(context.channelId,
                `**Job Timeout** (Job ID: \`${jobId}\`)\n\nThis job has been pending for too long. The agent might be offline.`,
              );
              this.trackedJobs.delete(jobId);
              continue;
            }
          }

          if (data.status === "done" || data.status === "failed") {
            await this.sendJobResult(jobId, data, context);
            this.trackedJobs.delete(jobId);
          }
        } catch (err: any) {
          // Keep trying
        }
      }

      await this.checkDiscordJobsFromAPI();
    } catch (err: any) {
      console.error(`Error in job watcher: ${err.message}`);
    }
  }

  private async checkDiscordJobsFromAPI(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/api/jobs/discord-completed`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) return;

      const data: any = await res.json();
      if (!data.ok || !data.jobs) return;

      for (const job of data.jobs) {
        const jobId = job.jobId;
        if (this.trackedJobs.has(jobId)) continue;
        if (!job.discordChannelId) continue;

        const context = {
          channelId: job.discordChannelId,
          isDM: job.discordIsDM || false,
        };

        await this.sendJobResult(jobId, job, context);
      }
    } catch {
      // Silently ignore
    }
  }

  private async sendJobResult(
    jobId: string,
    job: any,
    context: { channelId: string; isDM: boolean },
  ): Promise<void> {
    try {
      if (this.sentJobs.has(jobId)) return;

      this.stopTyping(jobId);

      let responseText = "";
      if (job.status === "done") {
        if (job.streamingText?.trim()) {
          responseText = job.streamingText.trim();
        } else if (job.result) {
          responseText = typeof job.result === "string" ? job.result : JSON.stringify(job.result);
        }
      } else {
        const errorText = job.result ? (typeof job.result === "string" ? job.result : JSON.stringify(job.result)) : "An error occurred";
        responseText = `Task failed: ${errorText}`;
      }

      if (!responseText?.trim()) {
        responseText = job.status === "done" ? "Done" : "Task failed";
      }

      await this.sendMessage(context.channelId, responseText);

      this.sentJobs.add(jobId);
      await this.markJobNotified(jobId);

      console.log(`✅ Sent job result for ${jobId} back to Discord`);
    } catch (err: any) {
      console.error(`Failed to send job result to Discord: ${err.message}`);
    }
  }

  private async markJobNotified(jobId: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/jobs/discord-notified`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
        },
        body: JSON.stringify({ jobId }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Non-fatal
    }
  }

  private async checkPendingApprovals(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/api/approvals/pending`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
        },
        body: JSON.stringify({ limit: 5 }),
      });

      if (!res.ok) return;

      const data = await res.json() as { ok: boolean; approvals: ApprovalNotification[] };
      if (!data.ok || !data.approvals) return;

      for (const approval of data.approvals) {
        await this.sendApprovalRequest(approval);
      }
    } catch {
      // Silently ignore
    }
  }

  private riskColor(level: string): number {
    switch (level) {
      case "low": return Colors.Blue;
      case "medium": return Colors.Yellow;
      case "high": return Colors.Orange;
      case "critical": return Colors.Red;
      default: return Colors.Grey;
    }
  }
}

// --- Factory: Load Discord config ---

export async function loadDiscordConfig(
  convexClient: any,
  apiKey: string,
  convexUrl: string,
): Promise<DiscordBot | null> {
  try {
    const botToken = process.env.DISCORD_BOT_TOKEN;
    const userId = process.env.DISCORD_USER_ID;
    const botId = process.env.DISCORD_BOT_ID;
    const channelId = process.env.DISCORD_CHANNEL_ID;
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    const enablePresence = process.env.DISCORD_ENABLE_PRESENCE === "true";
    const presenceType = (process.env.DISCORD_PRESENCE_TYPE as "activity" | "custom-status") || "activity";

    if (!botToken || !userId) {
      console.log("ℹ️  Discord not configured (set DISCORD_BOT_TOKEN and DISCORD_USER_ID in .env.local)");
      return null;
    }

    return new DiscordBot(
      { botToken, userId, botId, channelId, webhookUrl, enablePresence, presenceType },
      convexClient,
      apiKey,
      convexUrl,
    );
  } catch (err: any) {
    console.warn("Discord config load failed:", err.message);
    return null;
  }
}

export async function loadDiscordConfigFromConvex(
  convexClient: any,
  apiKey: string,
  convexUrl: string,
): Promise<DiscordBot | null> {
  try {
    const baseUrl = convexUrl.replace(".cloud", ".site");
    const res = await fetch(`${baseUrl}/api/settings/discord`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({}),
    });

    if (!res.ok) return null;

    const data = await res.json() as {
      ok: boolean;
      botToken?: string;
      userId?: string;
      botId?: string;
      channelId?: string;
      webhookUrl?: string;
      enablePresence?: boolean;
      presenceType?: "activity" | "custom-status";
    };

    if (!data.ok || !data.botToken || !data.userId) {
      return null;
    }

    return new DiscordBot(
      {
        botToken: data.botToken,
        userId: data.userId,
        botId: data.botId,
        channelId: data.channelId,
        webhookUrl: data.webhookUrl,
        enablePresence: data.enablePresence ?? false,
        presenceType: data.presenceType ?? "activity",
      },
      convexClient,
      apiKey,
      convexUrl,
    );
  } catch {
    return null;
  }
}

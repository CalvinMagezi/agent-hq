/**
 * Discord Bot Module for Agent-HQ Agent
 *
 * Provides Discord DM-based approval requests and job event mirroring.
 * This module is optional — if Discord settings are not configured,
 * it gracefully does nothing.
 */

import { PresenceManager } from "./lib/discordPresence.js";
import { classifyIntent } from "./lib/intentClassifier.js";
import type { ChatSessionManager } from "./lib/chatSession.js";

// --- Types ---

interface DiscordConfig {
    botToken: string;
    userId: string;       // Discord user ID to DM
    botId?: string;       // Bot's own user ID (for mention detection)
    channelId?: string;   // Optional channel for job events
    webhookUrl?: string;  // Optional webhook for notifications
    enablePresence?: boolean;  // Enable Discord presence updates
    presenceType?: "activity" | "custom-status";  // Presence display type
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

// --- Discord Bot Class ---

export class DiscordBot {
    private config: DiscordConfig;
    private client: any;
    private apiKey: string;
    private baseUrl: string;
    private botHeaders: Record<string, string>;
    private pollInterval: NodeJS.Timeout | null = null;
    private jobWatcherInterval: NodeJS.Timeout | null = null;
    private presenceManager: PresenceManager | null = null;
    private trackedJobs: Map<string, { channelId: string; isDM: boolean }> = new Map();
    private typingIntervals: Map<string, NodeJS.Timeout> = new Map(); // Track typing indicators per job
    private sentJobs: Set<string> = new Set(); // In-session dedup guard to prevent re-sending
    private chatSession: ChatSessionManager | null = null;
    private agentContext: { targetDir: string; workerId: string; isBusy: boolean; currentJobInstruction?: string } = {
        targetDir: process.cwd(),
        workerId: "unknown",
        isBusy: false,
    };

    constructor(config: DiscordConfig, convexClient: any, apiKey: string, convexUrl: string) {
        this.config = config;
        this.client = convexClient;
        this.apiKey = apiKey;
        this.baseUrl = convexUrl.replace(".cloud", ".site");
        this.botHeaders = {
            "Authorization": `Bot ${config.botToken}`,
            "Content-Type": "application/json",
        };
    }

    /**
     * Set the persistent chat session for handling Discord messages.
     */
    setChatSession(chatSession: ChatSessionManager): void {
        this.chatSession = chatSession;
    }

    /**
     * Update agent context for the intent classifier (isBusy, currentJob, etc.)
     */
    setAgentContext(ctx: { targetDir: string; workerId: string; isBusy: boolean; currentJobInstruction?: string }): void {
        this.agentContext = ctx;
    }

    /**
     * Start the Discord bot — polls for pending approvals and sends DMs.
     * Optionally starts presence manager if enabled in config.
     */
    async start(): Promise<void> {
        // Validate bot token by fetching current user
        try {
            const me = await this.discordApi("GET", "/users/@me");
            console.log(`🤖 Discord bot connected as: ${me.username}#${me.discriminator ?? "0"}`);
        } catch (err: any) {
            console.error("❌ Discord bot failed to connect:", err.message);
            return;
        }

        // Start presence manager if enabled
        if (this.config.enablePresence) {
            try {
                this.presenceManager = new PresenceManager();

                // Set up message handler
                this.presenceManager.setMessageHandler(async (message) => {
                    await this.handleMessage(message);
                });

                await this.presenceManager.start(this.config.botToken);
                console.log("✅ Discord presence enabled");
                console.log("💬 Discord message handling enabled");
            } catch (err: any) {
                console.warn("⚠️ Discord presence initialization failed:", err.message);
                console.log("   Continuing with REST-only mode...");
            }
        }

        // Start polling for pending approval notifications
        this.pollInterval = setInterval(() => this.checkPendingApprovals(), 5000);
        console.log("📡 Discord bot polling for approval requests...");

        // Start watching for completed jobs to send results back
        this.jobWatcherInterval = setInterval(() => this.checkCompletedJobs(), 3000);
        console.log("👀 Discord bot watching for completed jobs...");
    }

    async stop(): Promise<void> {
        // Stop presence manager first
        if (this.presenceManager) {
            await this.presenceManager.stop();
            this.presenceManager = null;
        }

        // Stop approval polling
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }

        // Stop job watcher
        if (this.jobWatcherInterval) {
            clearInterval(this.jobWatcherInterval);
            this.jobWatcherInterval = null;
        }

        // Stop all typing indicators
        for (const interval of this.typingIntervals.values()) {
            clearInterval(interval);
        }
        this.typingIntervals.clear();

        console.log("👋 Discord bot stopped.");
    }

    // --- Public Methods ---

    /**
     * Update Discord presence based on agent status.
     */
    async updatePresence(status: "online" | "busy" | "offline"): Promise<void> {
        await this.presenceManager?.updatePresence(status);
    }

    /**
     * Start typing indicator for a job in a channel.
     * The indicator will refresh every 8 seconds until stopped.
     */
    private startTypingIndicator(jobId: string, channelId: string): void {
        // Send initial typing indicator
        this.sendTypingIndicator(channelId);

        // Refresh typing indicator every 8 seconds (Discord typing lasts 10 seconds)
        const interval = setInterval(() => {
            this.sendTypingIndicator(channelId);
        }, 8000);

        // Track the interval so we can stop it later
        this.typingIntervals.set(jobId, interval);
    }

    /**
     * Stop typing indicator for a job.
     */
    private stopTypingIndicator(jobId: string): void {
        const interval = this.typingIntervals.get(jobId);
        if (interval) {
            clearInterval(interval);
            this.typingIntervals.delete(jobId);
        }
    }

    /**
     * Send a single typing indicator to a channel.
     */
    private async sendTypingIndicator(channelId: string): Promise<void> {
        try {
            await this.discordApi("POST", `/channels/${channelId}/typing`, {});
        } catch (err: any) {
            // Silently ignore typing indicator errors
            console.warn(`⚠️ Failed to send typing indicator: ${err.message}`);
        }
    }

    /**
     * Handle Discord messages using chat-first routing:
     * 1. Trivial messages → instant response (no LLM)
     * 2. Everything else → persistent chat session (lightweight LLM, can dispatch jobs)
     * 3. Fallback → create job directly (if chat session unavailable)
     */
    private async handleMessage(message: {
        content: string;
        author: { id: string; username: string };
        channelId: string;
        isDM: boolean;
        reply: (content: string) => Promise<void>;
    }): Promise<void> {
        const content = message.content.trim();

        // Ignore empty messages
        if (!content) return;

        // Only respond to DMs or messages mentioning the bot
        const isBotMentioned = this.config.botId ?
            content.includes(`<@${this.config.botId}>`) :
            content.includes("<@");

        if (!message.isDM && !isBotMentioned) {
            return;
        }

        // Strip bot mention from content if present
        let cleanContent = content;
        if (this.config.botId) {
            cleanContent = content.replace(new RegExp(`<@!?${this.config.botId}>`, "g"), "").trim();
        }
        if (!cleanContent) return;

        console.log(`💬 Discord message from ${message.author.username}: ${cleanContent.substring(0, 100)}`);

        // --- Tier 1: Instant response (no LLM) ---
        const classification = classifyIntent(cleanContent, this.agentContext);

        if (classification.tier === "instant" && classification.instantResponse) {
            console.log(`⚡ Instant response (${classification.reason})`);
            await message.reply(classification.instantResponse);
            return;
        }

        // --- Tier 2: Chat session (lightweight LLM) ---
        if (this.chatSession) {
            // Start recurring typing indicator (Discord typing lasts ~10s, refresh every 8s)
            await this.sendTypingIndicator(message.channelId);
            const typingTimer = setInterval(() => {
                this.sendTypingIndicator(message.channelId);
            }, 8000);

            // Set Discord context so dispatched jobs can send results back here
            this.chatSession.setDiscordContext({
                channelId: message.channelId,
                isDM: message.isDM,
                onJobDispatched: (jobId: string) => {
                    // Track dispatched job so the job watcher sends results to this channel
                    this.trackedJobs.set(jobId, {
                        channelId: message.channelId,
                        isDM: message.isDM,
                    });
                    // Start typing indicator for the background job
                    this.startTypingIndicator(jobId, message.channelId);
                    console.log(`📋 Tracking dispatched job ${jobId} for Discord delivery`);
                },
            });

            try {
                console.log(`💭 Routing to chat session...`);
                const response = await this.chatSession.handleMessage(cleanContent);

                // Stop typing before replying
                clearInterval(typingTimer);

                // Truncate if too long (Discord limit is 2000 chars)
                let replyText = response;
                if (replyText.length > 1900) {
                    replyText = replyText.substring(0, 1900) + "...";
                }

                await message.reply(replyText);
                console.log(`✅ Chat response sent (${replyText.length} chars)`);
                return;
            } catch (err: any) {
                clearInterval(typingTimer);
                console.error(`❌ Chat session error: ${err.message}`);
                // Fall through to job-based fallback
            }
        }

        // --- Fallback: Create a job (original behavior) ---
        console.log(`📋 Falling back to job creation (chat session unavailable)`);
        try {
            const res = await fetch(`${this.baseUrl}/api/jobs/create`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-API-Key": this.apiKey,
                },
                body: JSON.stringify({
                    instruction: cleanContent,
                    type: "background",
                    discordChannelId: message.channelId,
                    discordIsDM: message.isDM,
                }),
            });

            if (!res.ok) {
                const errorText = await res.text();
                console.error(`Failed to create job from Discord message: ${errorText}`);
                await message.reply("❌ Failed to create job. Please try again.");
                return;
            }

            const result: any = await res.json();
            const jobId = result.jobId;

            // Track this job so we can send results back when it completes
            this.trackedJobs.set(jobId, {
                channelId: message.channelId,
                isDM: message.isDM,
            });

            // Start typing indicator to show the agent is working
            this.startTypingIndicator(jobId, message.channelId);
            console.log(`✅ Created job ${jobId} from Discord message (typing indicator started)`);
        } catch (err: any) {
            console.error("Error creating job from Discord message:", err.message);
            await message.reply("❌ An error occurred while processing your request.");
        }
    }

    async sendApprovalRequest(notification: ApprovalNotification): Promise<void> {
        const dmChannelId = await this.getOrCreateDMChannel();
        if (!dmChannelId) return;

        const riskEmoji: Record<string, string> = {
            low: "🟢",
            medium: "🟡",
            high: "🟠",
            critical: "🔴",
        };

        await this.discordApi("POST", `/channels/${dmChannelId}/messages`, {
            embeds: [{
                title: `${riskEmoji[notification.riskLevel] || "⚪"} Approval Required`,
                description: notification.description,
                color: this.riskColor(notification.riskLevel),
                fields: [
                    { name: "Tool", value: notification.toolName, inline: true },
                    { name: "Risk Level", value: notification.riskLevel.toUpperCase(), inline: true },
                    { name: "ID", value: notification.approvalId, inline: true },
                ],
                footer: { text: "Reply with: !approve <id> or !reject <id> <reason>" },
            }],
            components: [{
                type: 1, // ACTION_ROW
                components: [
                    {
                        type: 2, // BUTTON
                        style: 3, // SUCCESS
                        label: "Approve",
                        custom_id: `approve_${notification.approvalId}`,
                    },
                    {
                        type: 2,
                        style: 4, // DANGER
                        label: "Reject",
                        custom_id: `reject_${notification.approvalId}`,
                    },
                ],
            }],
        });
    }

    async sendJobEvent(event: JobEvent): Promise<void> {
        // Send to webhook or channel if configured
        const channelId = this.config.channelId;
        const webhookUrl = this.config.webhookUrl;

        const emoji: Record<string, string> = {
            started: "🚀",
            completed: "✅",
            failed: "❌",
            cancelled: "🚫",
        };

        const colorMap: Record<string, number> = {
            completed: 0x22c55e,
            failed: 0xef4444,
            cancelled: 0xfbbf24,
            started: 0x3b82f6,
        };

        const embed = {
            title: `${emoji[event.type] || "ℹ️"} Job ${event.type.charAt(0).toUpperCase() + event.type.slice(1)}`,
            description: event.instruction.substring(0, 200),
            color: colorMap[event.type] ?? 0x3b82f6,
            fields: event.error ? [{ name: "Error", value: event.error.substring(0, 200) }] : [],
            timestamp: new Date().toISOString(),
        };

        if (webhookUrl) {
            try {
                await fetch(webhookUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ embeds: [embed] }),
                });
            } catch (err: any) {
                console.warn("Discord webhook send failed:", err.message);
            }
        } else if (channelId) {
            try {
                await this.discordApi("POST", `/channels/${channelId}/messages`, {
                    embeds: [embed],
                });
            } catch (err: any) {
                console.warn("Discord channel message failed:", err.message);
            }
        }
    }

    /**
     * Send a plain-text or embed progress message to the configured channel.
     * Used by WaitForDelegationTool for autonomous delegation updates.
     * No-ops silently if Discord is not configured.
     */
    async sendProgressMessage(content: string, embed?: {
        title: string;
        description: string;
        color: number;
        fields?: Array<{ name: string; value: string; inline?: boolean }>;
        timestamp?: string;
    }): Promise<void> {
        const channelId = this.config.channelId;
        const webhookUrl = this.config.webhookUrl;

        if (!channelId && !webhookUrl) return;

        const payload: Record<string, any> = embed
            ? { embeds: [{ ...embed, timestamp: embed.timestamp ?? new Date().toISOString() }] }
            : { content };

        if (webhookUrl) {
            try {
                await fetch(webhookUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
            } catch (err: any) {
                console.warn("Discord webhook progress message failed:", err.message);
            }
        } else if (channelId) {
            try {
                await this.discordApi("POST", `/channels/${channelId}/messages`, payload);
            } catch (err: any) {
                console.warn("Discord channel progress message failed:", err.message);
            }
        }
    }

    // --- Internal Methods ---

    private async checkCompletedJobs(): Promise<void> {
        try {
            const now = Date.now();
            const STUCK_JOB_TIMEOUT = 5 * 60 * 1000; // 5 minutes

            // Method 1: Check tracked jobs (fast path for recent jobs)
            for (const [jobId, context] of this.trackedJobs.entries()) {
                console.log(`🔍 Checking job status: ${jobId}`);

                try {
                    const res = await fetch(`${this.baseUrl}/api/jobs/status`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "X-API-Key": this.apiKey,
                        },
                        body: JSON.stringify({ jobId }),
                        signal: AbortSignal.timeout(10000), // 10 second timeout
                    });

                    if (!res.ok) {
                        console.log(`   ⚠️ Job status check failed: ${res.status}`);

                        // If job not found (404), stop tracking it
                        if (res.status === 404) {
                            console.log(`   ⚠️ Job not found, removing from tracking`);
                            this.trackedJobs.delete(jobId);
                        }
                        continue;
                    }

                    const data: any = await res.json();
                    console.log(`   📊 Job status: ${data.status || "unknown"}`);

                    if (!data.ok) continue;

                    // Check if job is stuck in pending for too long
                    if (data.status === "pending" && data.createdAt) {
                        const age = now - data.createdAt;
                        if (age > STUCK_JOB_TIMEOUT) {
                            console.log(`   ⚠️ Job stuck in pending for ${Math.floor(age / 1000)}s, notifying user`);
                            await this.sendStuckJobNotification(jobId, context);
                            this.trackedJobs.delete(jobId);
                            continue;
                        }
                    }

                    // If job is done or failed, send result back to Discord
                    if (data.status === "done" || data.status === "failed") {
                        console.log(`   ✅ Job completed, sending result to Discord...`);
                        await this.sendJobResult(jobId, data, context);
                        this.trackedJobs.delete(jobId);
                    }
                } catch (err: any) {
                    console.warn(`   ⚠️ Network error checking job: ${err.message}`);
                    // Don't delete the job, keep trying
                }
            }

            // Method 2: Query API for completed Discord jobs (catches jobs after restart)
            await this.checkDiscordJobsFromAPI();
        } catch (err: any) {
            console.error(`❌ Error in job watcher: ${err.message}`);
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

            // Send notifications for completed jobs not yet notified (filtered by DB)
            for (const job of data.jobs) {
                const jobId = job.jobId;

                // Skip if still being tracked by the active watcher
                if (this.trackedJobs.has(jobId)) continue;

                // Skip if no Discord context
                if (!job.discordChannelId) continue;

                console.log(`📬 Found completed Discord job from API: ${jobId}`);

                const context = {
                    channelId: job.discordChannelId,
                    isDM: job.discordIsDM || false,
                };

                await this.sendJobResult(jobId, job, context);
            }
        } catch {
            // Silently ignore API errors
        }
    }

    private async sendJobResult(
        jobId: string,
        job: any,
        context: { channelId: string; isDM: boolean },
    ): Promise<void> {
        try {
            // Prevent duplicate sends within the same session
            if (this.sentJobs.has(jobId)) {
                console.log(`⏭️ Already sent result for ${jobId}, skipping`);
                return;
            }

            console.log(`📤 Preparing to send job result for ${jobId}`);
            console.log(`   Channel ID: ${context.channelId}, isDM: ${context.isDM}`);

            // Stop typing indicator before sending result
            this.stopTypingIndicator(jobId);

            const channel = await this.discordApi("GET", `/channels/${context.channelId}`);
            if (!channel) {
                console.log(`   ⚠️ Channel not found`);
                return;
            }

            // Get the last assistant message from streamingText or result
            let responseText = "";
            if (job.status === "done") {
                // Extract the last assistant response from streamingText
                if (job.streamingText && job.streamingText.trim()) {
                    responseText = job.streamingText.trim();
                } else if (job.result) {
                    responseText = typeof job.result === "string" ? job.result : JSON.stringify(job.result);
                } else {
                    // If no streamingText or result, fetch job logs
                    responseText = await this.getJobResponse(jobId);
                }
            } else {
                // For failed jobs, result contains the error info
                const errorText = job.result ? (typeof job.result === "string" ? job.result : JSON.stringify(job.result)) : "An error occurred";
                responseText = `❌ Task failed: ${errorText}`;
            }

            console.log(`   Response text length: ${responseText.length} chars`);

            // If still empty, use fallback
            if (!responseText || responseText.trim().length === 0) {
                responseText = job.status === "done"
                    ? "✅ Done"
                    : "❌ Task failed";
            }

            // Truncate if too long (Discord limit is 2000 chars)
            if (responseText.length > 1900) {
                responseText = responseText.substring(0, 1900) + "...";
            }

            await this.discordApi("POST", `/channels/${context.channelId}/messages`, {
                content: responseText,
            });

            // Mark as sent in-memory immediately to prevent re-sends
            this.sentJobs.add(jobId);

            // Mark job as notified in the database so it won't be re-sent on restart
            await this.markJobNotified(jobId);

            console.log(`✅ Sent job result for ${jobId} back to Discord`);
        } catch (err: any) {
            console.error(`❌ Failed to send job result to Discord: ${err.message}`);
            console.error(`   Stack: ${err.stack}`);
        }
    }

    /**
     * Mark a job as Discord-notified in Convex so it won't be re-sent on restart.
     */
    private async markJobNotified(jobId: string): Promise<void> {
        try {
            const res = await fetch(`${this.baseUrl}/api/jobs/discord-notified`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-API-Key": this.apiKey,
                },
                body: JSON.stringify({ jobId }),
                signal: AbortSignal.timeout(5000),
            });

            if (!res.ok) {
                const text = await res.text();
                console.error(`⚠️ Failed to mark job ${jobId} as notified: ${res.status} ${text}`);
            }
        } catch (err: any) {
            console.error(`⚠️ Network error marking job ${jobId} as notified: ${err.message}`);
        }
    }

    private async getJobResponse(_jobId: string): Promise<string> {
        // TODO: Implement job logs API endpoint to fetch full response
        // For now, return empty and rely on fallback message
        return "";
    }

    private async sendStuckJobNotification(
        jobId: string,
        context: { channelId: string; isDM: boolean },
    ): Promise<void> {
        try {
            // Stop typing indicator before sending timeout notification
            this.stopTypingIndicator(jobId);

            await this.discordApi("POST", `/channels/${context.channelId}/messages`, {
                content: `⚠️ **Job Timeout** (Job ID: \`${jobId}\`)\n\nThis job has been pending for too long and may be stuck. The agent might be offline or unable to process it. Please try again later or check the agent status.`,
            });
            console.log(`⏰ Sent timeout notification for ${jobId}`);
        } catch (err: any) {
            console.warn(`Failed to send timeout notification: ${err.message}`);
        }
    }

    private async checkPendingApprovals(): Promise<void> {
        try {
            // Poll the Convex HTTP endpoint for pending approvals
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
            // Silently ignore polling errors
        }
    }

    private async getOrCreateDMChannel(): Promise<string | null> {
        try {
            const dm = await this.discordApi("POST", "/users/@me/channels", {
                recipient_id: this.config.userId,
            });
            return dm.id;
        } catch (err: any) {
            console.warn("Failed to create DM channel:", err.message);
            return null;
        }
    }

    private async discordApi(method: string, path: string, body?: unknown): Promise<any> {
        const res = await fetch(`https://discord.com/api/v10${path}`, {
            method,
            headers: this.botHeaders,
            body: body ? JSON.stringify(body) : undefined,
        });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Discord API ${method} ${path} failed (${res.status}): ${text}`);
        }

        const contentType = res.headers.get("content-type");
        if (contentType?.includes("application/json")) {
            return res.json();
        }
        return null;
    }

    private riskColor(level: string): number {
        switch (level) {
            case "low": return 0x3b82f6;     // Blue
            case "medium": return 0xeab308;   // Yellow
            case "high": return 0xf97316;     // Orange
            case "critical": return 0xef4444;  // Red
            default: return 0x6b7280;         // Gray
        }
    }
}

// --- Factory: Load Discord config ---

/**
 * Load Discord config from environment variables (local-only mode).
 * For production with Convex cloud, use loadDiscordConfigFromConvex instead.
 */
export async function loadDiscordConfig(
    convexClient: any,
    apiKey: string,
    convexUrl: string,
): Promise<DiscordBot | null> {
    try {
        // LOCAL MODE: Load from environment variables
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
            {
                botToken,
                userId,
                botId,
                channelId,
                webhookUrl,
                enablePresence,
                presenceType,
            },
            convexClient,
            apiKey,
            convexUrl,
        );
    } catch (err: any) {
        console.warn("⚠️ Discord config load failed:", err.message);
        return null;
    }
}

/**
 * Load Discord config from Convex settings (cloud mode).
 * Use this when running with Convex cloud + authentication.
 */
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

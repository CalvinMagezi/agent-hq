/**
 * Discord Presence Manager
 *
 * Manages Discord gateway WebSocket connection for real-time presence updates.
 * Uses discord.js for reliable gateway connection and presence management.
 */

import type { Client as DiscordClient } from "discord.js";
import * as DiscordJS from "discord.js";

type AgentStatus = "online" | "busy" | "offline";

type MessageHandler = (message: {
    content: string;
    author: { id: string; username: string; bot: boolean };
    channelId: string;
    isDM: boolean;
    reply: (content: string) => Promise<void>;
}) => Promise<void>;

/**
 * PresenceManager handles Discord gateway connection and presence updates.
 *
 * Features:
 * - Built on discord.js for reliability
 * - Automatic reconnection handling
 * - Debouncing (5s) to avoid Discord rate limits
 * - Graceful degradation on failures
 * - Message handling for commands
 */
export class PresenceManager {
    private client: DiscordClient | null = null;
    private lastPresenceUpdate = 0;
    private debounceMs = 5000; // 5 seconds
    private isStopped = false;
    private messageHandler: MessageHandler | null = null;

    /**
     * Set message handler for processing Discord messages.
     */
    setMessageHandler(handler: MessageHandler): void {
        this.messageHandler = handler;
    }

    /**
     * Start the presence manager with the provided bot token.
     */
    async start(token: string): Promise<void> {
        this.isStopped = false;

        // Initialize Discord.js client with intents for presence and messages
        this.client = new DiscordJS.Client({
            intents: [
                DiscordJS.GatewayIntentBits.Guilds,
                DiscordJS.GatewayIntentBits.GuildMessages,
                DiscordJS.GatewayIntentBits.DirectMessages,
                DiscordJS.GatewayIntentBits.MessageContent, // Required to read message content
            ],
            partials: [
                DiscordJS.Partials.Channel, // Required for DM support
                DiscordJS.Partials.Message,
            ],
        });

        // Set up event handlers
        this.client.once("ready", () => {
            console.log(`✅ Discord presence connected as: ${this.client!.user?.tag}`);
            console.log(`📡 Listening for message events with intents: ${this.client!.options.intents.bitfield}`);
            console.log(`📡 Registered guilds: ${this.client!.guilds.cache.size}`);

            // Set initial presence to online immediately
            this.client!.user?.setPresence({
                status: DiscordJS.PresenceUpdateStatus.Online,
                activities: [{
                    name: "Idle — ready for tasks",
                    type: DiscordJS.ActivityType.Watching,
                }],
            });
        });

        // Debug: Log all events to see what we're receiving
        this.client.on("debug", (info) => {
            if (info.includes("MESSAGE_CREATE")) {
                console.log(`🔍 [DEBUG] ${info}`);
            }
        });

        this.client.on("error", (error: Error) => {
            console.warn("⚠️ Discord client error:", error.message);
        });

        this.client.on("disconnect", () => {
            if (!this.isStopped) {
                console.warn("⚠️ Discord gateway disconnected (will auto-reconnect)");
            }
        });

        // Handle messages
        this.client.on("messageCreate", async (message) => {
            console.log(`📨 Message received: "${message.content.substring(0, 50)}..." from ${message.author.username} (bot: ${message.author.bot})`);

            // Ignore bot messages
            if (message.author.bot) {
                console.log("   ⏩ Skipping bot message");
                return;
            }

            // Only process if we have a message handler
            if (!this.messageHandler) {
                console.log("   ⚠️ No message handler registered");
                return;
            }

            console.log("   ✅ Processing message...");
            try {
                await this.messageHandler({
                    content: message.content,
                    author: {
                        id: message.author.id,
                        username: message.author.username,
                        bot: message.author.bot,
                    },
                    channelId: message.channelId,
                    isDM: message.channel.type === DiscordJS.ChannelType.DM,
                    reply: async (content: string) => {
                        await message.reply(content);
                    },
                });
            } catch (err: any) {
                console.error("Error handling Discord message:", err.message);
            }
        });

        // Login to Discord
        try {
            await this.client.login(token);
        } catch (err: any) {
            console.error("❌ Discord presence login failed:", err.message);
            throw err;
        }
    }

    /**
     * Update Discord presence based on agent status.
     * Debounced to avoid rate limits (5 updates/min).
     */
    async updatePresence(status: AgentStatus): Promise<void> {
        if (!this.client || !this.client.user || this.isStopped) return;

        // Debounce to avoid rate limits
        const now = Date.now();
        if (now - this.lastPresenceUpdate < this.debounceMs) {
            return;
        }
        this.lastPresenceUpdate = now;

        try {
            switch (status) {
                case "online":
                    await this.client.user.setPresence({
                        status: DiscordJS.PresenceUpdateStatus.Online,
                        activities: [{
                            name: "Idle — ready for tasks",
                            type: DiscordJS.ActivityType.Watching,
                        }],
                    });
                    break;

                case "busy":
                    await this.client.user.setPresence({
                        status: DiscordJS.PresenceUpdateStatus.DoNotDisturb,
                        activities: [{
                            name: "a task",
                            type: DiscordJS.ActivityType.Playing,
                        }],
                    });
                    break;

                case "offline":
                    await this.client.user.setPresence({
                        status: DiscordJS.PresenceUpdateStatus.Invisible,
                        activities: [],
                    });
                    break;
            }

            console.log(`✅ Discord presence updated: ${status}`);
        } catch (err: any) {
            console.warn("⚠️ Discord presence update failed:", err.message);
        }
    }

    /**
     * Stop the presence manager and disconnect from gateway.
     */
    async stop(): Promise<void> {
        this.isStopped = true;

        if (this.client) {
            try {
                await this.client.destroy();
                console.log("👋 Discord presence manager stopped");
            } catch (err: any) {
                console.warn("⚠️ Discord disconnect error:", err.message);
            }
        }
    }
}

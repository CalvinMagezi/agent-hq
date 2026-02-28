import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  type Message,
  type Interaction,
} from "discord.js";
import type { DiscordBotConfig, IncomingMessage, BotStatus, PresenceConfig } from "./types.js";
import { PresenceManager } from "./presenceManager.js";
import { TypingManager } from "./typingManager.js";
import { CommandRegistry } from "./commandSystem/registry.js";
import { stripMention, isBotAddressed, isAuthorized } from "./mentionUtils.js";
import { chunkMessage } from "./chunker.js";

export interface BotBaseOptions {
  config: DiscordBotConfig;
  /** Extra intents beyond the defaults */
  intents?: GatewayIntentBits[];
  /** Presence configuration */
  presence?: PresenceConfig;
  /** Logging label (e.g., "Claude Code") */
  label?: string;
  /** Max dedup set size (default: 200) */
  dedupSize?: number;
}

/**
 * Abstract base class for Discord bots.
 * Handles client creation, login, dedup, auth, presence, typing, commands.
 * Subclasses implement onMessage() for domain-specific behavior.
 */
export abstract class DiscordBotBase {
  protected client: Client | null = null;
  protected config: DiscordBotConfig;
  protected typing: TypingManager;
  protected presence: PresenceManager;
  protected commands: CommandRegistry;
  protected label: string;
  private processedMessages = new Set<string>();
  private dedupSize: number;
  private extraIntents: GatewayIntentBits[];

  constructor(options: BotBaseOptions) {
    this.config = options.config;
    this.label = options.label ?? "Bot";
    this.dedupSize = options.dedupSize ?? 200;
    this.extraIntents = options.intents ?? [];
    this.typing = new TypingManager();
    this.presence = new PresenceManager(options.presence);
    this.commands = new CommandRegistry();
  }

  /** Start the bot: create client, login, begin listening. */
  async start(): Promise<void> {
    const intents = [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
      ...this.extraIntents,
    ];

    this.client = new Client({
      intents,
      partials: [Partials.Channel, Partials.Message],
    });

    this.typing.setClient(this.client);
    this.presence.setClient(this.client);

    this.client.once("ready", async () => {
      console.log(`[${this.label}] Discord bot connected as: ${this.client!.user?.tag}`);

      // Auto-detect bot ID if not configured
      if (!this.config.botId && this.client!.user) {
        this.config.botId = this.client!.user.id;
      }

      // Set initial presence
      this.presence.update("online");

      // Register slash commands
      const slashDefs = this.commands.getSlashDefs();
      if (slashDefs.length > 0) {
        try {
          await this.client!.application!.commands.set(
            slashDefs.map((d) => d.toJSON()),
          );
          console.log(`[${this.label}] Registered ${slashDefs.length} slash commands`);
        } catch (err: any) {
          console.error(`[${this.label}] Failed to register slash commands:`, err.message);
        }
      }

      // Call subclass hook
      await this.onReady?.();
    });

    // Message handling with dedup + auth
    this.client.on("messageCreate", (msg) => this.handleRawMessage(msg));

    // Interaction handling (slash commands + autocomplete)
    this.client.on("interactionCreate", (interaction) =>
      this.handleInteraction(interaction),
    );

    this.client.on("error", (err) => {
      console.error(`[${this.label}] Discord error:`, err.message);
      this.onError?.(err);
    });

    await this.client.login(this.config.botToken);
  }

  /** Graceful shutdown. */
  async stop(): Promise<void> {
    this.typing.stopAll();
    if (this.client) {
      this.presence.update("offline");
      // Short delay to let presence propagate
      await new Promise((r) => setTimeout(r, 500));
      await this.client.destroy();
      this.client = null;
      console.log(`[${this.label}] Discord bot stopped.`);
    }
  }

  /** Update bot presence (debounced). */
  setPresence(status: BotStatus): void {
    this.presence.update(status);
  }

  /** Start typing indicator for a key in a channel. */
  startTyping(key: string, channelId: string): void {
    this.typing.start(key, channelId);
  }

  /** Stop typing indicator for a key. */
  stopTyping(key: string): void {
    this.typing.stop(key);
  }

  /** Send a message to a channel, auto-chunking if >2000 chars. */
  async sendMessage(channelId: string, content: string): Promise<void> {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !("send" in channel)) return;
      const chunks = chunkMessage(content);
      for (const chunk of chunks) {
        await (channel as any).send(chunk);
      }
    } catch (err: any) {
      console.error(`[${this.label}] Failed to send message:`, err.message);
    }
  }

  /** Send one or more file attachments to a channel. */
  async sendFile(channelId: string, files: import("discord.js").AttachmentBuilder[]): Promise<void> {
    if (!this.client || files.length === 0) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !("send" in channel)) return;
      await (channel as any).send({ files });
    } catch (err: any) {
      console.error(`[${this.label}] Failed to send file attachment:`, err.message);
    }
  }

  /** Send an embed to a channel. */
  async sendEmbed(channelId: string, embed: import("discord.js").EmbedBuilder): Promise<void> {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !("send" in channel)) return;
      await (channel as any).send({ embeds: [embed] });
    } catch (err: any) {
      console.error(`[${this.label}] Failed to send embed:`, err.message);
    }
  }

  /** Get the underlying Discord client (for advanced use). */
  getClient(): Client | null {
    return this.client;
  }

  // ── Subclass hooks ─────────────────────────────────────────────────

  /** Handle an incoming authorized, deduplicated, mention-stripped message. */
  abstract onMessage(msg: IncomingMessage): Promise<void>;

  /** Called when the bot is ready and connected. */
  onReady?(): Promise<void>;

  /** Called on client errors. */
  onError?(err: Error): void;

  /** Override to customize interaction auth (default: check config.userId). */
  protected isInteractionAuthorized(userId: string): boolean {
    return isAuthorized(userId, this.config.userId);
  }

  /**
   * Override to handle interactions before the command registry dispatch.
   * Return true if handled, false to fall through to registry.
   */
  protected async onInteraction?(interaction: import("discord.js").Interaction): Promise<boolean>;

  // ── Internal ───────────────────────────────────────────────────────

  private async handleRawMessage(msg: Message): Promise<void> {
    // Ignore bot messages
    if (msg.author.bot) return;

    // Dedup
    if (this.processedMessages.has(msg.id)) return;
    this.processedMessages.add(msg.id);
    if (this.processedMessages.size > this.dedupSize) {
      const first = this.processedMessages.values().next().value;
      if (first) this.processedMessages.delete(first);
    }

    // Auth check
    if (!isAuthorized(msg.author.id, this.config.userId)) return;

    const isDM = msg.channel.type === ChannelType.DM;
    const rawContent = msg.content;

    // Only process DMs or messages mentioning the bot
    if (!isBotAddressed(rawContent, isDM, this.config.botId)) return;

    const content = stripMention(rawContent, this.config.botId);
    if (!content) return;

    console.log(`[${this.label}] Message ${msg.id} from ${msg.author.username}: ${content.substring(0, 80)}`);

    const incoming: IncomingMessage = {
      content,
      rawContent,
      author: {
        id: msg.author.id,
        username: msg.author.username,
        bot: msg.author.bot,
      },
      channelId: msg.channelId,
      isDM,
      message: msg,
    };

    try {
      await this.onMessage(incoming);
    } catch (err: any) {
      console.error(`[${this.label}] Error in onMessage:`, err.message);
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    // Let subclass handle first if it has an onInteraction override
    if (this.onInteraction) {
      const handled = await this.onInteraction(interaction);
      if (handled) return;
    }

    if (interaction.isChatInputCommand()) {
      if (!this.isInteractionAuthorized(interaction.user.id)) {
        await interaction.reply({ content: "Unauthorized.", ephemeral: true });
        return;
      }

      const ctx = this.getCommandContext();
      const handled = await this.commands.dispatchSlash(interaction, ctx);
      if (!handled) {
        await interaction.reply({
          content: "Unknown command.",
          ephemeral: true,
        });
      }
    } else if (interaction.isAutocomplete()) {
      const ctx = this.getCommandContext();
      await this.commands.dispatchAutocomplete(interaction, ctx);
    }
  }

  /** Override in subclasses to provide domain-specific command context. */
  protected getCommandContext(): import("./commandSystem/types.js").CommandContext {
    return { botConfig: this.config };
  }
}

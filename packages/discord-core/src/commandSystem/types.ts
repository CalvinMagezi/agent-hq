import type {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
} from "discord.js";
import type { CommandResult, DiscordBotConfig } from "../types.js";

/**
 * Unified command definition that supports both `!prefix` and `/slash` variants.
 */
export interface CommandDef {
  /** Primary command name (e.g., "model", "reset") */
  name: string;
  /** Alternative prefix triggers (e.g., ["!new"] for reset) */
  aliases?: string[];
  /** Short description for help text */
  description: string;
  /** Category for grouping in help output */
  category?: "session" | "model" | "tuning" | "info" | "hq" | "plugin";
  /** Slash command builder — null means prefix-only */
  slashDef?: SlashCommandBuilder;
  /** Handle `!prefix arg` invocation */
  handlePrefix?(
    arg: string,
    channelId: string,
    ctx: CommandContext,
  ): Promise<CommandResult>;
  /** Handle `/slash` interaction */
  handleSlash?(
    interaction: ChatInputCommandInteraction,
    ctx: CommandContext,
  ): Promise<void>;
  /** Handle autocomplete for this slash command */
  handleAutocomplete?(
    interaction: AutocompleteInteraction,
    ctx: CommandContext,
  ): Promise<void>;
  /** Filter: return false to hide this command for a given consumer */
  isAvailable?(ctx: CommandContext): boolean;
}

/**
 * Context passed to command handlers.
 * Base fields are shared; consumers extend with domain-specific properties.
 */
export interface CommandContext {
  botConfig: DiscordBotConfig;
  /** Consumer-specific data (relay: harness/convex, agent: chatSession) */
  [key: string]: unknown;
}

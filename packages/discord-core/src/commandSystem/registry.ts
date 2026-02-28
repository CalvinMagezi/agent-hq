import type {
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  SlashCommandBuilder,
} from "discord.js";
import type { CommandDef, CommandContext } from "./types.js";
import type { CommandResult } from "../types.js";

/**
 * CommandRegistry — central dispatch for both prefix and slash commands.
 */
export class CommandRegistry {
  private commands = new Map<string, CommandDef>();
  private aliasToPrimary = new Map<string, string>();

  /** Register a batch of command definitions. */
  registerAll(defs: CommandDef[]): void {
    for (const def of defs) {
      this.commands.set(def.name, def);
      // Register aliases
      if (def.aliases) {
        for (const alias of def.aliases) {
          // Normalize: strip leading ! if present
          const normalized = alias.startsWith("!") ? alias.slice(1) : alias;
          this.aliasToPrimary.set(normalized, def.name);
        }
      }
    }
  }

  /** Get all registered command definitions. */
  getAll(): CommandDef[] {
    return [...this.commands.values()];
  }

  /** Get available commands filtered by context. */
  getAvailable(ctx: CommandContext): CommandDef[] {
    return this.getAll().filter(
      (cmd) => !cmd.isAvailable || cmd.isAvailable(ctx),
    );
  }

  /** Get slash command builders for registration with Discord API. */
  getSlashDefs(ctx?: CommandContext): SlashCommandBuilder[] {
    const cmds = ctx ? this.getAvailable(ctx) : this.getAll();
    return cmds
      .filter((cmd) => cmd.slashDef)
      .map((cmd) => cmd.slashDef!);
  }

  /**
   * Dispatch a prefix command.
   * @param rawCommand - The full command string (e.g., "!model sonnet")
   * @param channelId - Discord channel ID
   * @param ctx - Command context
   * @returns CommandResult if handled, null if no matching command
   */
  async dispatchPrefix(
    rawCommand: string,
    channelId: string,
    ctx: CommandContext,
  ): Promise<CommandResult | null> {
    // Parse command name and argument
    const trimmed = rawCommand.trim();
    if (!trimmed.startsWith("!") && !trimmed.startsWith("/")) return null;

    const spaceIdx = trimmed.indexOf(" ");
    const cmdName = (spaceIdx === -1 ? trimmed : trimmed.substring(0, spaceIdx))
      .slice(1) // Remove ! or /
      .toLowerCase();
    const arg = spaceIdx === -1 ? "" : trimmed.substring(spaceIdx + 1).trim();

    // Look up by primary name or alias
    const primaryName = this.aliasToPrimary.get(cmdName) ?? cmdName;
    const def = this.commands.get(primaryName);

    if (!def) return null;
    if (def.isAvailable && !def.isAvailable(ctx)) return null;
    if (!def.handlePrefix) return null;

    return def.handlePrefix(arg, channelId, ctx);
  }

  /**
   * Dispatch a slash command interaction.
   */
  async dispatchSlash(
    interaction: ChatInputCommandInteraction,
    ctx: CommandContext,
  ): Promise<boolean> {
    const def = this.commands.get(interaction.commandName);
    if (!def?.handleSlash) return false;
    if (def.isAvailable && !def.isAvailable(ctx)) return false;

    await def.handleSlash(interaction, ctx);
    return true;
  }

  /**
   * Dispatch an autocomplete interaction.
   */
  async dispatchAutocomplete(
    interaction: AutocompleteInteraction,
    ctx: CommandContext,
  ): Promise<boolean> {
    const def = this.commands.get(interaction.commandName);
    if (!def?.handleAutocomplete) return false;

    await def.handleAutocomplete(interaction, ctx);
    return true;
  }
}

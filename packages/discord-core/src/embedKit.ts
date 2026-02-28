import { EmbedBuilder, Colors } from "discord.js";

/**
 * Generic embed factories for common Discord embed patterns.
 * Domain-specific embeds (session, usage, status) stay in consumers.
 */

/** Create an info embed (blue). */
export function infoEmbed(title: string, description?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(Colors.Blue)
    .setTimestamp();
  if (description) embed.setDescription(description);
  return embed;
}

/** Create a success embed (green). */
export function successEmbed(title: string, description?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(Colors.Green)
    .setTimestamp();
  if (description) embed.setDescription(description);
  return embed;
}

/** Create a warning embed (gold/yellow). */
export function warningEmbed(title: string, description?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(Colors.Gold)
    .setTimestamp();
  if (description) embed.setDescription(description);
  return embed;
}

/** Create an error embed (red). */
export function errorEmbed(title: string, description?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(Colors.Red)
    .setTimestamp();
  if (description) embed.setDescription(description);
  return embed;
}

/**
 * Format an ISO date string as a human-readable "time ago" string.
 */
export function formatTimeAgo(isoString: string | null): string {
  if (!isoString) return "never";
  const ms = Date.now() - new Date(isoString).getTime();
  if (ms < 0) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

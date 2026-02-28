/**
 * Strip bot mention from message content.
 * Handles both <@ID> and <@!ID> formats.
 */
export function stripMention(content: string, botId?: string): string {
  if (!botId) return content;
  return content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

/**
 * Check if a message is directed at the bot (DM or mention).
 */
export function isBotAddressed(
  content: string,
  isDM: boolean,
  botId?: string,
): boolean {
  if (isDM) return true;
  if (!botId) return content.includes("<@");
  return content.includes(`<@${botId}>`) || content.includes(`<@!${botId}>`);
}

/**
 * Check if a user is authorized to interact with the bot.
 */
export function isAuthorized(
  authorId: string,
  authorizedUserId: string,
): boolean {
  return authorId === authorizedUserId;
}

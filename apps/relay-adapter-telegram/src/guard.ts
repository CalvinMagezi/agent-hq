/**
 * TelegramGuard — Immutable security boundary for the Telegram relay adapter.
 *
 * Ensures the bot can ONLY respond to the owner's Telegram user ID.
 * No other users are accessible — ever. This is by design and
 * cannot be changed at runtime.
 *
 * The guard is frozen with Object.freeze() at construction time.
 * There are no setters, no admin overrides, no mutation methods.
 */

export class TelegramGuard {
  /** The only Telegram user ID this adapter is allowed to interact with. */
  readonly ownerUserId: number;

  constructor(userId: string | number) {
    const parsed = typeof userId === "string" ? parseInt(userId, 10) : userId;

    if (!parsed || isNaN(parsed) || parsed <= 0) {
      throw new Error(
        "SECURITY: TELEGRAM_USER_ID must be a positive integer. " +
          "Send /start to @userinfobot on Telegram to find your numeric user ID.",
      );
    }

    this.ownerUserId = parsed;

    // Freeze this instance — no properties can be added, removed, or changed
    Object.freeze(this);
  }

  /** Returns true ONLY if the user ID matches the owner. */
  isAllowedUser(userId: number): boolean {
    return userId === this.ownerUserId;
  }

  /** Throws if the user ID is not the owner. Use as defense-in-depth. */
  assertAllowed(userId: number): void {
    if (!this.isAllowedUser(userId)) {
      throw new Error(
        `SECURITY: Blocked access from user ${userId}. ` +
          `Only ${this.ownerUserId} is permitted.`,
      );
    }
  }
}

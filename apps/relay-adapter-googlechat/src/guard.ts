/**
 * GoogleChatGuard — Immutable security boundary for the Google Chat relay adapter.
 *
 * Ensures the adapter can ONLY process messages from the owner's Google Chat
 * user ID. All other users are silently ignored. This is by design and
 * cannot be changed at runtime.
 *
 * The guard is frozen with Object.freeze() at construction time.
 * There are no setters, no admin overrides, no mutation methods.
 */

export class GoogleChatGuard {
  /** The only Google Chat user ID this adapter is allowed to interact with (e.g. "users/123456789"). */
  readonly ownerUserId: string;

  constructor(userId: string) {
    if (!userId || !userId.startsWith("users/")) {
      throw new Error(
        "SECURITY: GOOGLE_CHAT_USER_ID must be a Google Chat user ID string (e.g. 'users/123456789'). " +
          "Find it by listing messages in your space: " +
          "gws chat spaces.messages list --params '{\"parent\":\"spaces/XXXX\"}' " +
          "and checking the sender.name field.",
      );
    }

    this.ownerUserId = userId;

    // Freeze this instance — no properties can be added, removed, or changed
    Object.freeze(this);
  }

  /** Returns true ONLY if the user ID matches the owner. */
  isAllowedUser(userId: string): boolean {
    return userId === this.ownerUserId;
  }

  /** Throws if the user ID is not the owner. Use as defense-in-depth. */
  assertAllowed(userId: string): void {
    if (!this.isAllowedUser(userId)) {
      throw new Error(
        `SECURITY: Blocked access from user ${userId}. ` +
          `Only ${this.ownerUserId} is permitted.`,
      );
    }
  }
}

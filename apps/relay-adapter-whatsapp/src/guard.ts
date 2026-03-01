/**
 * WhatsAppGuard — Immutable security boundary for the WhatsApp relay adapter.
 *
 * Ensures the agent can ONLY see and respond to the owner's self-chat.
 * No other conversations are accessible — ever. This is by design and
 * cannot be changed at runtime.
 *
 * The guard is frozen with Object.freeze() at construction time.
 * There are no setters, no admin overrides, no mutation methods.
 */

const SELF_CHAT_JID_PATTERN = /^\d+@s\.whatsapp\.net$/;

export class WhatsAppGuard {
  /** The only JID this adapter is allowed to interact with. */
  readonly ownerJid: string;

  constructor(jid: string) {
    if (!jid || typeof jid !== "string") {
      throw new Error("SECURITY: WHATSAPP_OWNER_JID is required and must be a string");
    }

    if (!SELF_CHAT_JID_PATTERN.test(jid)) {
      throw new Error(
        `SECURITY: Invalid owner JID format: "${jid}". ` +
          "Must be digits followed by @s.whatsapp.net (e.g., 256XXXXXXXXX@s.whatsapp.net). " +
          "Group JIDs (@g.us) are explicitly forbidden.",
      );
    }

    this.ownerJid = jid;

    // Freeze this instance — no properties can be added, removed, or changed
    Object.freeze(this);
  }

  /** Returns true ONLY if the JID matches the owner's self-chat. */
  isAllowedChat(jid: string): boolean {
    return jid === this.ownerJid;
  }

  /** Returns true ONLY if the recipient matches the owner's self-chat. */
  isAllowedRecipient(jid: string): boolean {
    return jid === this.ownerJid;
  }

  /** Throws if the JID is not the owner's self-chat. Use as defense-in-depth. */
  assertAllowed(jid: string): void {
    if (!this.isAllowedChat(jid)) {
      throw new Error(
        `SECURITY: Blocked access to non-owner chat "${jid}". ` +
          `Only "${this.ownerJid}" is permitted.`,
      );
    }
  }
}

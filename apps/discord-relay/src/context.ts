import { readFile } from "fs/promises";
import { join } from "path";
import type { ConvexAPI } from "./vaultApi.js";
import type { RelayConfig } from "./types.js";

export class ContextEnricher {
  private convex: ConvexAPI;
  private config: RelayConfig;
  private profileContext: string = "";

  constructor(convex: ConvexAPI, config: RelayConfig) {
    this.convex = convex;
    this.config = config;
  }

  async loadProfile(): Promise<void> {
    try {
      this.profileContext = await readFile(
        join(this.config.relayDir, "profile.md"),
        "utf-8",
      );
    } catch {
      // No profile file — that's fine
    }
  }

  /**
   * Build an enriched prompt with vault context before calling Claude.
   * Fetches pinned notes, semantic search results, memory facts, and recent
   * conversation history in parallel.
   */
  async buildPrompt(
    userMessage: string,
    channelId?: string,
  ): Promise<string> {
    const [relevantNotes, pinnedNotes, memoryFacts, recentMessages] =
      await Promise.all([
        this.convex.searchNotes(userMessage, 5),
        this.convex.getPinnedNotes(),
        this.convex.getMemoryFacts(),
        channelId
          ? this.convex.getRecentMessages(channelId, 10)
          : Promise.resolve([]),
      ]);

    const now = new Date();
    const timeStr = now.toLocaleString("en-US", {
      timeZone: this.config.timezone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const parts: string[] = [
      "You are a personal AI assistant responding via Discord. Keep responses concise and conversational. Use markdown formatting compatible with Discord.",
    ];

    if (this.config.userName) {
      parts.push(`You are speaking with ${this.config.userName}.`);
    }
    parts.push(`Current time: ${timeStr}`);

    if (this.profileContext) {
      parts.push(`\nProfile:\n${this.profileContext}`);
    }

    // Pinned notes as persistent context
    if (pinnedNotes.length > 0) {
      parts.push("\nPINNED NOTES (always available):");
      for (const note of pinnedNotes.slice(0, 5)) {
        parts.push(`- [${note.title}]: ${note.content.substring(0, 300)}`);
      }
    }

    // Memory facts and goals
    if (memoryFacts.length > 0) {
      const facts = memoryFacts.filter((f) => f.type === "fact");
      const goals = memoryFacts.filter((f) => f.type === "goal");

      if (facts.length > 0) {
        parts.push("\nFACTS:");
        facts.forEach((f) => parts.push(`- ${f.content}`));
      }
      if (goals.length > 0) {
        parts.push("\nGOALS:");
        goals.forEach((g) => {
          const deadline = g.deadline ? ` (by ${g.deadline})` : "";
          parts.push(`- ${g.content}${deadline}`);
        });
      }
    }

    // Relevant past notes from semantic search
    if (relevantNotes.length > 0) {
      parts.push("\nRELEVANT NOTES:");
      for (const note of relevantNotes) {
        const notebook = note.notebook ? ` (${note.notebook})` : "";
        parts.push(
          `- [${note.title}]${notebook}: ${note.content.substring(0, 200)}`,
        );
      }
    }

    // Recent conversation history
    if (recentMessages.length > 0) {
      parts.push("\nRECENT CONVERSATION:");
      for (const msg of recentMessages) {
        const label = msg.role === "user" ? "User" : "Assistant";
        // Truncate long messages in history to save context
        const body =
          msg.content.length > 300
            ? msg.content.substring(0, 300) + "..."
            : msg.content;
        parts.push(`${label}: ${body}`);
      }
    }

    // Memory management instructions
    parts.push(
      "\nMEMORY MANAGEMENT:" +
        "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
        "include these tags in your response (they are processed automatically and hidden from the user):" +
        "\n[REMEMBER: fact to store]" +
        "\n[GOAL: goal text | DEADLINE: optional date]" +
        "\n[DONE: search text for completed goal]",
    );

    parts.push(`\nUser: ${userMessage}`);

    return parts.join("\n");
  }
}

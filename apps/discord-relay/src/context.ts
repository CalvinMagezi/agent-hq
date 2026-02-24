import { readFile } from "fs/promises";
import { join } from "path";
import type { ConvexAPI } from "./vaultApi.js";
import type { RelayConfig } from "./types.js";

export class ContextEnricher {
  private convex: ConvexAPI;
  private config: RelayConfig;
  private profileContext: string = "";
  private harnessType: string;

  constructor(convex: ConvexAPI, config: RelayConfig, harnessType?: string) {
    this.convex = convex;
    this.config = config;
    this.harnessType = harnessType || "claude-code";
  }

  /**
   * Returns the stable system-level instruction for this harness type.
   * This should be passed as `--append-system-prompt` (not in the user prompt),
   * so the harness CLI treats it as a genuine system directive rather than
   * just text in the user's input that gets overridden by the CLI's own system prompt.
   */
  buildSystemInstruction(): string {
    const userName = this.config.userName ? `You are speaking with ${this.config.userName}. ` : "";

    const continuityInstructions =
      "\n\nCONTEXT RULES (follow strictly):\n" +
      "- You are responding via Discord, not running a coding task from a job queue.\n" +
      "- The RECENT CONVERSATION block in the prompt is your shared conversation history with the user — treat it as real prior turns.\n" +
      "- When the user sends a short reply ('yes', 'proceed', 'continue', 'go ahead') or replies to a specific message, " +
      "use the RECENT CONVERSATION and REPLYING TO sections to determine what they mean — do NOT ask for clarification about context you already have.\n" +
      "- Maintain topic continuity: if you were working on a specific task, assume you are continuing it unless the user explicitly changes topic.\n" +
      "- Never say you don't have context if RECENT CONVERSATION messages are present in the prompt.";

    const memoryInstructions =
      "\n\nMEMORY MANAGEMENT:\n" +
      "When the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (processed automatically, hidden from user):\n" +
      "[REMEMBER: fact to store]\n" +
      "[GOAL: goal text | DEADLINE: optional date]\n" +
      "[DONE: search text for completed goal]";

    switch (this.harnessType) {
      case "gemini-cli":
        return (
          "You are a Google Workspace specialist responding via Discord. " +
          "Your primary role is managing Google Docs, Sheets, Drive, Gmail, Calendar, Keep, and Chat. " +
          "You also excel at research, analysis, and summarization. " +
          "You do NOT write code unless the user explicitly insists — suggest Claude Code or OpenCode for coding tasks. " +
          "Keep responses concise and use Discord-compatible markdown. " +
          userName +
          continuityInstructions +
          memoryInstructions
        );
      case "opencode":
        return (
          "You are a multi-model coding assistant responding via Discord. " +
          "You specialize in code generation, model comparison, and file operations. " +
          "Keep responses concise and conversational. Use markdown formatting compatible with Discord. " +
          userName +
          continuityInstructions +
          memoryInstructions
        );
      case "claude-code":
      default:
        return (
          "You are a personal AI assistant responding via Discord. " +
          "You specialize in code editing, git operations, debugging, and complex refactoring. " +
          "Keep responses concise and conversational. Use markdown formatting compatible with Discord. " +
          userName +
          continuityInstructions +
          memoryInstructions
        );
    }
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
   *
   * @param replyToMessage - Content of the Discord message being replied to, if any.
   *   Provides the agent with explicit context about which prior message the user is responding to.
   */
  async buildPrompt(
    userMessage: string,
    channelId?: string,
    replyToMessage?: string,
  ): Promise<string> {
    const [relevantNotes, pinnedNotes, memoryFacts, recentMessages] =
      await Promise.all([
        this.convex.searchNotes(userMessage, 5),
        this.convex.getPinnedNotes(),
        this.convex.getMemoryFacts(),
        channelId
          ? this.convex.getRecentMessages(channelId, 20)
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

    // Note: system role/identity/continuity instructions are passed separately as --append-system-prompt.
    // Only dynamic context (time, notes, history, current message) goes here.
    const parts: string[] = [];

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
        // Truncate very long messages to preserve context window — keep enough to understand topic
        const body =
          msg.content.length > 800
            ? msg.content.substring(0, 800) + "..."
            : msg.content;
        parts.push(`${label}: ${body}`);
      }
    }

    // Explicit reply-to context — included when the user replied to a specific prior message
    if (replyToMessage) {
      parts.push(
        "\nREPLYING TO (the specific message the user is responding to):\n" +
          replyToMessage,
      );
    }

    parts.push(`\nUser: ${userMessage}`);

    return parts.join("\n");
  }
}
